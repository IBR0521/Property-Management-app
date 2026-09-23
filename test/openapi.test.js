/* The specification against the code it describes.

   A hand-written OpenAPI document is wrong within two releases and nothing
   makes it wrong loudly: the code keeps working, the document keeps being
   served, and the first anybody hears is an integrator asking why a field
   they were promised is not there.

   So the document is generated from the declarations the responses are built
   from, and this file is the thing that makes that claim true rather than
   merely intended. It touches no database — a document generator that needs a
   connection is a generator nobody runs in CI. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openApiSpec, API_VERSION } from "../server/lib/api/openapi.js";
import { RESOURCES, RESOURCE_NAMES } from "../server/lib/api/resources.js";
import { SCOPES } from "../server/lib/api/scopes.js";

const spec = openApiSpec();

describe("the document describes what is actually served", () => {
  test("every resource has a list and a fetch", () => {
    for (const plural of RESOURCE_NAMES) {
      assert.ok(spec.paths[`/${plural}`]?.get, `/${plural} has no list operation`);
      assert.ok(spec.paths[`/${plural}/{id}`]?.get, `/${plural}/{id} has no fetch operation`);
    }
  });

  test("and nothing is described that is not served", () => {
    for (const path of Object.keys(spec.paths)) {
      const plural = path.replace(/^\//, "").replace(/\/\{id\}$/, "");
      assert.ok(RESOURCE_NAMES.includes(plural), `${path} is documented and does not exist`);
    }
  });

  test("every declared field is in the schema, with the same name", () => {
    for (const plural of RESOURCE_NAMES) {
      const resource = RESOURCES[plural];
      const name = pascal(resource.name);
      const schema = spec.components.schemas[name];
      assert.ok(schema, `no schema for ${plural}`);

      const declared = resource.fields.map(([f]) => f).sort();
      assert.deepEqual(Object.keys(schema.properties).sort(), declared,
        `${plural}: the schema and the response are built from the same list and disagree`);
      assert.deepEqual([...schema.required].sort(), declared,
        `${plural}: every field is always present, null rather than absent`);
    }
  });

  test("an amount is an integer in the schema, because it is one in the response", () => {
    for (const plural of RESOURCE_NAMES) {
      for (const [field, , type] of RESOURCES[plural].fields) {
        if (!/_cents$/.test(field)) continue;
        const schema = spec.components.schemas[pascal(RESOURCES[plural].name)].properties[field];
        assert.equal(schema.type, "integer", `${plural}.${field} is documented as ${schema.type}`);
        assert.equal(type.startsWith("integer"), true);
      }
    }
  });

  test("every operation names the scope that actually gates it", () => {
    for (const plural of RESOURCE_NAMES) {
      const declared = RESOURCES[plural].scope;
      for (const path of [`/${plural}`, `/${plural}/{id}`]) {
        const [[, scopes]] = Object.entries(spec.paths[path].get.security[0]);
        assert.deepEqual(scopes, [declared], `${path} documents the wrong scope`);
      }
    }
  });

  test("the writes are documented with their own request bodies", () => {
    const wo = spec.paths["/work-orders"].post;
    assert.ok(wo);
    assert.deepEqual(wo.security, [{ bearerAuth: ["maintenance:write"] }]);
    const body = wo.requestBody.content["application/json"].schema;
    assert.deepEqual(body.required, ["unit_id", "summary"]);
    assert.deepEqual(body.properties.severity.enum, ["normal", "urgent", "emergency"]);

    const pay = spec.paths["/payments"].post;
    assert.deepEqual(pay.security, [{ bearerAuth: ["money:write"] }]);
    assert.ok(pay.responses[409], "a closed period is part of the contract, not a surprise");
  });

  test("the invariant is in the documentation, not only in the code", () => {
    const wo = spec.paths["/work-orders"].post;
    assert.match(wo.description, /emergency is never queued/i,
      "somebody reading the docs to decide what severity to send has to know this");
    assert.ok(wo.responses[201].content["application/json"].schema.allOf[1]
      .properties.emergency, "and the response shape has to carry it");
  });

  test("every scope in the document is a scope that exists", () => {
    for (const name of Object.keys(spec["x-scopes"])) {
      assert.ok(SCOPES[name], `${name} is documented and is not a scope`);
    }
    assert.deepEqual(Object.keys(spec["x-scopes"]).sort(), Object.keys(SCOPES).sort());
  });

  test("it is a 3.1 document with one way in", () => {
    assert.equal(spec.openapi, "3.1.0");
    assert.equal(spec.info.version, API_VERSION);
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, "bearer");
    assert.equal(spec.servers[0].url, `/api/${API_VERSION}`);
  });

  test("it serialises, which is the only form anybody will read it in", () => {
    const json = JSON.stringify(spec);
    assert.ok(json.length > 2000);
    assert.deepEqual(JSON.parse(json).paths["/units"].get.summary, "List units");
  });

  test("a base URL is used when one is given", () => {
    const hosted = openApiSpec({ baseUrl: "https://app.example.com" });
    assert.equal(hosted.servers[0].url, `https://app.example.com/api/${API_VERSION}`);
  });
});

describe("what is deliberately not published", () => {
  /* Columns a table has and the API does not. Each one is a decision, and a
     test is where a decision survives somebody adding a field to a
     declaration without thinking about it. */
  const WITHHELD = {
    "work-orders": ["public_token", "triage_answers", "reported_by_phone"],
    payments: ["stripe_payment_intent_id", "stripe_charge_id", "stripe_checkout_session_id"],
  };

  for (const [plural, columns] of Object.entries(WITHHELD)) {
    test(`${plural} does not publish ${columns.join(", ")}`, () => {
      const declared = RESOURCES[plural].fields.map(([f]) => f);
      for (const column of columns) {
        assert.equal(declared.includes(column), false,
          `${column} is now published — a work order's token is a capability, and the `
          + "processor's identifiers are the processor's");
      }
    });
  }
});

function pascal(name) {
  return String(name).split(/[_-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}
