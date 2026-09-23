/* What goes in a webhook body.

   Built from the same declarations `/api/v1` responds with, so a receiver
   that has written code against the API does not have to write it twice —
   and so a field cannot mean one thing in a response and another in a
   webhook. The alternative is two descriptions of a work order that agree
   until somebody changes one of them.

   These take ids and read, rather than taking rows, because a caller inside
   a transaction has a row that is half-written as often as not. Reading it
   back is one query and it is the row as it will actually be. */
import { get, all } from "../db.js";
import { RESOURCES, shape, columnsFor } from "../api/resources.js";

const cols = (plural) => columnsFor(RESOURCES[plural]).map((c) => `"${c}"`).join(", ");

export async function workOrderPayload(workOrderId, extra = {}) {
  const row = await get(
    `SELECT ${cols("work-orders")} FROM work_order WHERE id = ?`, workOrderId);
  if (!row) return null;
  return { work_order: { ...shape(RESOURCES["work-orders"], row), ...extra } };
}

export async function paymentPayload({ entryId, journalId }) {
  const entry = entryId
    ? await get(`SELECT ${cols("ledger-entries")} FROM ledger_entry WHERE id = ?`, entryId)
    : null;
  const journal = await get(`SELECT ${cols("journals")} FROM journal WHERE id = ?`, journalId);
  const splits = await all(
    `SELECT a.code AS account_code, a.name AS account_name,
            s.debit_cents, s.credit_cents, s.memo,
            s.owner_id, s.property_id, s.unit_id, s.lease_id
       FROM journal_split s JOIN account a ON a.id = s.account_id
      WHERE s.journal_id = ? ORDER BY a.code`, journalId);

  return {
    /* Null when the receipt earned the owner nothing yet — which happens, and
       is not the same as the payment not existing. */
    ledger_entry: entry ? shape(RESOURCES["ledger-entries"], entry) : null,
    journal: journal ? {
      ...shape(RESOURCES.journals, { ...journal, splits: [] }),
      splits: splits.map((s) => ({
        ...s,
        debit_cents: Number(s.debit_cents),
        credit_cents: Number(s.credit_cents),
      })),
    } : null,
  };
}

/* A returned payment. The lease's own state comes with it because a return
   often changes it — a closed account puts the tenancy on cash-only — and a
   receiver that had to ask a second question to find that out would be
   looking at a different moment by the time it did. */
export async function paymentReturnedPayload(paymentId) {
  const payment = await get(
    `SELECT ${cols("payments")} FROM tenant_payment WHERE id = ?`, paymentId);
  if (!payment) return null;

  const lease = await get(
    `SELECT id, payments_blocked, payments_blocked_reason FROM lease WHERE id = ?`,
    payment.lease_id);

  return {
    payment: shape(RESOURCES.payments, payment),
    lease: lease ? {
      id: lease.id,
      payments_blocked: Boolean(Number(lease.payments_blocked)),
      payments_blocked_reason: lease.payments_blocked_reason || null,
    } : null,
  };
}

export async function leaseSignedPayload(documentId) {
  const doc = await get(
    `SELECT id, lease_id, unit_id, title, kind, status, completed_at, created_at
       FROM lease_document WHERE id = ?`, documentId);
  if (!doc) return null;

  const lease = doc.lease_id
    ? await get(`SELECT ${cols("leases")} FROM lease WHERE id = ?`, doc.lease_id)
    : null;
  const signatures = await all(
    `SELECT party_type, party_name, signed_at FROM lease_signature
      WHERE document_id = ? ORDER BY signed_at`, documentId);

  return {
    document: {
      id: doc.id, lease_id: doc.lease_id, unit_id: doc.unit_id,
      title: doc.title, kind: doc.kind, status: doc.status,
      completed_at: doc.completed_at, created_at: doc.created_at,
    },
    lease: lease ? shape(RESOURCES.leases, { ...lease, tenant_ids: [] }) : null,
    signatures,
  };
}

export async function approvalPayload(approvalId) {
  const approval = await get(
    `SELECT id, owner_id, work_order_id, amount_cents, status,
            requested_at, decided_at, decided_note
       FROM owner_approval WHERE id = ?`, approvalId);
  if (!approval) return null;

  const workOrder = approval.work_order_id
    ? await get(`SELECT ${cols("work-orders")} FROM work_order WHERE id = ?`,
        approval.work_order_id)
    : null;

  return {
    approval: { ...approval, amount_cents: Number(approval.amount_cents) },
    work_order: workOrder ? shape(RESOURCES["work-orders"], workOrder) : null,
  };
}
