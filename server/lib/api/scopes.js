/* The scope vocabulary, and the capability each one is capped by.

   Its own file, importing nothing, so that the specification can be built
   without a database — a document generator that needs a connection is a
   document generator nobody runs in CI.

   Deliberately coarse. A scope per endpoint reads like precision and is
   really a list nobody maintains, and the ceiling that matters is the
   holder's role, which is already fine-grained. A scope can only take
   away: a key carrying `money:write` whose holder has no `money.write`
   can do nothing with it, which is the right way round. The alternative
   is an API that is a privilege escalation with documentation. */
export const SCOPES = {
  "portfolio:read": {
    capability: "property.view",
    describes: "Read properties, units, leases and tenants",
  },
  "portfolio:write": {
    capability: "property.edit",
    describes: "Create and change those records",
  },
  "maintenance:read": {
    capability: "maintenance.work",
    describes: "Read work orders and their history",
  },
  "maintenance:write": {
    capability: "maintenance.work",
    describes: "Raise a work order",
  },
  "money:read": {
    capability: "money.view",
    describes: "Read owners, ledgers, payments and the journal",
  },
  "money:write": {
    capability: "money.write",
    describes: "Record a payment received",
  },
};

export const SCOPE_NAMES = Object.keys(SCOPES);
