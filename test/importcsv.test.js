/* Reading a CSV somebody else wrote, and working out what its columns mean.

   Writing CSV, this application controls. Reading, it controls nothing: the
   file arrives from a competitor's export, a spreadsheet, or a person, and it
   will contain at least one of a byte order mark, mixed line endings, quoted
   fields with newlines inside them, doubled quotes, a trailing blank line,
   and a column somebody renamed.

   The rule underneath all of it: **it does not guess.** A required field with
   no matching column stops the import and says what it looked for. It does
   not pick the most likely column, because the most likely column is
   sometimes the wrong one and nobody finds out until the rent roll is. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, readTable, normaliseHeader } from "../server/lib/import/csv.js";
import { mapHeaders, applyMapping, ENTITIES, entityOrder } from "../server/lib/import/mappings.js";

/* --- the shapes a real file arrives in ------------------------------------- */

describe("parsing", () => {
  test("a byte order mark does not become part of the first column", async () => {
    /* Excel writes one. A parser that leaves it produces a column called
       "﻿Name" that matches nothing, and the failure reads as "no name
       column" on a file that plainly has one. */
    const t = readTable("﻿Name,Rent\r\nA,100\r\n");
    assert.deepEqual(t.headers, ["Name", "Rent"]);
    assert.equal(t.rows[0].name, "A");
  });

  test("CRLF, LF and a file with both", async () => {
    const mixed = readTable("Name,Rent\r\nA,100\nB,200\r\nC,300");
    assert.equal(mixed.rows.length, 3);
    assert.deepEqual(mixed.rows.map((r) => r.name), ["A", "B", "C"]);
  });

  test("a comma inside a quoted field is not a delimiter", async () => {
    const t = readTable('Name,Address\nA,"1 Main St, Columbus, OH"\n');
    assert.equal(t.rows[0].address, "1 Main St, Columbus, OH");
    assert.equal(t.problems.length, 0);
  });

  test("a newline inside a quoted field does not end the row", async () => {
    /* A two-line address is how a thirty-row file becomes sixty. */
    const t = readTable('Name,Notes\nA,"line one\nline two"\nB,x\n');
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows[0].notes, "line one\nline two");
    assert.equal(t.rows[1].name, "B");
  });

  test("a doubled quote is one quote", async () => {
    const t = readTable('Name,Notes\nA,"say ""hi"" twice"\n');
    assert.equal(t.rows[0].notes, 'say "hi" twice');
  });

  test("a quote that is not at the start of a cell is literal", async () => {
    /* 6" pipe. Treating it as an opening quote swallows the rest of the
       file. */
    const t = readTable('Name,Notes\nA,6" pipe\nB,x\n');
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows[0].notes, '6" pipe');
  });

  test("trailing blank lines are not rows", async () => {
    const t = readTable("Name,Rent\nA,100\n\n\n");
    assert.equal(t.rows.length, 1);
    assert.equal(t.problems.length, 0, "a blank line is not a problem, it is nothing");
  });

  test("semicolons and tabs are recognised", async () => {
    /* A European export is semicolon-separated and a tab-separated file is
       routine. Both arrive named .csv. */
    assert.equal(readTable("Name;Rent\nA;100\n").rows[0].rent, "100");
    assert.equal(readTable("Name\tRent\nA\t100\n").rows[0].rent, "100");
  });

  test("a comma inside a quoted header does not outvote the real delimiter", async () => {
    /* Sniffed from outside the quotes, or a semicolon file with one quoted
       header full of commas is read as comma-separated. */
    const t = readTable('"Name, formal";Rent\nA;100\n');
    assert.equal(t.delimiter, ";");
    assert.equal(t.rows[0].rent, "100");
  });

  test("an empty file says so rather than throwing", async () => {
    const t = readTable("   \n");
    assert.deepEqual(t.rows, []);
    assert.match(t.problems[0].message, /empty/);
  });
});

/* --- what it refuses to paper over ------------------------------------------ */

describe("what it reports rather than fixes", () => {
  test("a row with the wrong number of cells is a problem, not a padded row", async () => {
    /* Padding it invents a value; truncating it loses one. Both are silent,
       and an unescaped comma is the usual cause — which the message says. */
    const t = readTable("Name,Rent\nA,100,oops\nB,200\n");
    assert.equal(t.rows.length, 1, "only the good row");
    assert.equal(t.problems[0].row, 2, "named by the line number in the file");
    assert.match(t.problems[0].message, /3 values against 2 columns/);
    assert.match(t.problems[0].message, /unescaped comma/);
  });

  test("a duplicate header is a problem, because one column becomes unreachable", async () => {
    const t = readTable("Name,Rent,Name\nA,100,B\n");
    assert.match(t.problems[0].message, /appears twice/);
    assert.match(t.problems[0].message, /no way to say which/);
  });

  test("the row number is the line in the file, not the index in the array", async () => {
    /* So somebody can open the file and go to it. */
    const t = readTable("Name\nA\nB\nC\n");
    assert.deepEqual(t.rows.map((r) => r.__row), [2, 3, 4]);
  });
});

/* --- headers are matched loosely, values are not --------------------------- */

describe("header matching", () => {
  test("case, spaces, underscores and punctuation are all noise", async () => {
    assert.equal(normaliseHeader("  Market-Rent "), "market rent");
    assert.equal(normaliseHeader("UNIT_LABEL"), "unit label");
    assert.equal(normaliseHeader("Zip Code."), "zip code");
  });

  test("a realistic competitor export maps", async () => {
    const m = mapHeaders("property",
      ["PropertyID", "Owner ID", "Address 1", "City", "State", "Zip Code", "Property Type", "Rentable Sq Ft"]);

    assert.equal(m.mapping.sourceId, "PropertyID");
    assert.equal(m.mapping.ownerSourceId, "Owner ID");
    assert.equal(m.mapping.line1, "Address 1");
    assert.deepEqual(m.missing, []);
  });

  test("a column it does not use is reported, not an error", async () => {
    /* AppFolio exports forty columns and this uses eight. Erroring on the
       other thirty-two would make the feature unusable — but somebody has to
       be told what was not read. */
    const m = mapHeaders("property", ["Address", "City", "State", "Zip", "Rentable Sq Ft", "Manager"]);
    assert.deepEqual(m.ignored, ["Rentable Sq Ft", "Manager"]);
    assert.deepEqual(m.missing, []);
  });

  test("a required field with no column stops it, and says what it looked for", async () => {
    const m = mapHeaders("property", ["Address", "State", "Zip"]);
    assert.equal(m.missing.length, 1);
    assert.equal(m.missing[0].field, "city");
    assert.match(m.missing[0].message, /Looked for: city, town/);
  });

  test("it does not pick the most likely column for a field it cannot find", async () => {
    /* "Location" is probably the address. Probably is not good enough when
       the consequence is a portfolio with the wrong addresses on it. */
    const m = mapHeaders("property", ["Location", "City", "State", "Zip"]);
    assert.ok(m.missing.some((x) => x.field === "line1"));
    assert.ok(m.ignored.includes("Location"));
  });

  test("the first matching column wins, not the last", async () => {
    /* A file with both "rent" and "monthly rent" has one real one, and
       taking the later would depend on column order. */
    const m = mapHeaders("unit", ["Unit", "Rent", "Market Rent"]);
    assert.equal(m.mapping.marketRent, "Rent");
    assert.ok(m.ignored.includes("Market Rent"));
  });

  test("two entities sharing an alias do not resolve to each other's field", async () => {
    /* "id" means the owner on the owners file and the property on the
       properties one. An alias table shared between them would resolve a
       property's id as an owner's. */
    assert.equal(mapHeaders("owner", ["ID", "Name"]).mapping.sourceId, "ID");
    assert.equal(mapHeaders("property", ["ID", "Address", "City", "State", "Zip"]).mapping.sourceId, "ID");
  });

  test("a row is read through the mapping, by this application's names", async () => {
    const m = mapHeaders("unit", ["Unit Number", "BR", "Market Rent"]);
    const { rows } = readTable("Unit Number,BR,Market Rent\n12B,2,1450\n");
    const mapped = applyMapping(rows[0], m);

    assert.equal(mapped.label, "12B");
    assert.equal(mapped.beds, "2");
    assert.equal(mapped.marketRent, "1450");
    assert.equal(mapped.__row, 2, "the line number survives, for the error message");
  });
});

/* --- the shape of the thing ------------------------------------------------- */

describe("the entities", () => {
  test("they are ordered so a reference exists before something points at it", async () => {
    /* A lease points at a unit, which points at a property, which points at
       an owner. Importing them in any other order means resolving a
       reference to a row that is not there yet. */
    const order = entityOrder();
    assert.ok(order.indexOf("owner") < order.indexOf("property"));
    assert.ok(order.indexOf("property") < order.indexOf("unit"));
    assert.ok(order.indexOf("unit") < order.indexOf("lease"));
    assert.ok(order.indexOf("tenant") < order.indexOf("lease"));
  });

  test("every entity demands something, one way or the other", async () => {
    /* A guard on the rest: an entity with nothing required would import
       blank rows and report success.

       Units and leases satisfy it through requiredOneOf rather than a plain
       required flag — a unit must say which property it is in, and a file
       may do that with an id or an address. This test is how that gap was
       found: `unit` required nothing at all. */
    for (const [key, spec] of Object.entries(ENTITIES)) {
      assert.ok(spec.label, `${key} has no label`);
      const required = Object.values(spec.fields).filter((f) => f.required).length;
      const groups = (spec.requiredOneOf || []).length;
      assert.ok(required + groups > 0, `${key} requires nothing`);
    }
  });

  test("a unit with no way to name its property is refused", async () => {
    const m = mapHeaders("unit", ["Unit", "BR", "Market Rent"]);
    assert.equal(m.missing.length, 1);
    assert.match(m.missing[0].message, /one of them is needed/);
    assert.match(m.missing[0].message, /property id/);
  });

  test("either alternative satisfies it", async () => {
    assert.deepEqual(mapHeaders("unit", ["Property ID", "Unit"]).missing, []);
    assert.deepEqual(mapHeaders("unit", ["Property Address", "Unit"]).missing, []);
  });

  test("a lease must name its unit somehow", async () => {
    const without = mapHeaders("lease", ["Lease From", "Rent Amount"]);
    assert.ok(without.missing.some((x) => x.field === "unitSourceId or unitLabel"));

    const withId = mapHeaders("lease", ["Unit Id", "Lease From", "Rent Amount"]);
    assert.deepEqual(withId.missing, []);
  });

  test("every required field this database demands is required here too", async () => {
    /* The two lists must agree or the import fails at the insert with a
       constraint error instead of at validation with an explanation. */
    const demanded = {
      owner: ["name"],
      property: ["line1", "city", "state", "zip"],
      tenant: ["name"],
      lease: ["startDate", "rent"],
      vendor: ["name", "trade"],
    };
    for (const [entity, fields] of Object.entries(demanded)) {
      for (const field of fields) {
        assert.ok(ENTITIES[entity].fields[field]?.required,
          `${entity}.${field} is NOT NULL in the database and optional here`);
      }
    }
  });
});
