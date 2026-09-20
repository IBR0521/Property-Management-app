/* Maintenance categories and severity.

   Severity is still decided by what the tenant tells us rather than by asking
   them to rate their own urgency — but it is now ONE pick-the-closest question
   instead of a battery of yes/no ones.

   Why the change: a tenant with a dead outlet had to answer six questions,
   two of which ("can you smell gas?", "is anyone in danger?") were asked on
   every category and duplicated the red banner at the top of the page. That
   banner is the better place for it: if someone can smell gas we want them
   phoning, not completing a form field about it.

   Each option carries its own severity, so picking the line that matches is
   the whole triage. Options are ordered worst-first, which is also the order
   someone scanning in a hurry needs them in. */

export const CATEGORIES = [
  {
    key: "plumbing", label: "Plumbing", trade: "plumber",
    blurb: "Leaks, blocked drains, toilets, water heaters",
    options: [
      { key: "flooding", label: "Water is running or flooding and I can't stop it", severity: "emergency" },
      { key: "sewage", label: "Sewage or waste water is backing up", severity: "emergency" },
      { key: "no_water", label: "There's no running water at all", severity: "urgent" },
      { key: "one_fixture", label: "One sink, bath or toilet has a problem", severity: "normal" },
      { key: "other", label: "Something else plumbing", severity: "normal" },
    ],
  },
  {
    key: "electrical", label: "Electrical", trade: "electrician",
    blurb: "Outlets, lighting, breakers, smoke alarms",
    options: [
      { key: "burning", label: "I can smell burning, or see smoke, sparks or scorch marks", severity: "emergency" },
      { key: "no_power", label: "The whole unit has no power", severity: "emergency" },
      { key: "partial_power", label: "Some outlets or lights are dead", severity: "urgent" },
      { key: "alarm", label: "A smoke or carbon monoxide alarm is chirping or dead", severity: "urgent" },
      { key: "other", label: "Something else electrical", severity: "normal" },
    ],
  },
  {
    key: "hvac", label: "Heating & cooling", trade: "hvac",
    blurb: "Furnace, air conditioning, thermostat",
    options: [
      { key: "no_heat_cold", label: "The heat is out and it's cold in here", severity: "emergency" },
      { key: "no_cool_hot", label: "The cooling is out and it's dangerously hot", severity: "emergency" },
      { key: "vulnerable", label: "It's out, and there's a baby, an elderly or unwell person here", severity: "emergency" },
      { key: "intermittent", label: "It works, but not properly", severity: "normal" },
      { key: "other", label: "Something else with the heating or cooling", severity: "normal" },
    ],
  },
  {
    key: "appliance", label: "Appliance", trade: "appliance",
    blurb: "Fridge, cooker, dishwasher, washer, dryer",
    options: [
      { key: "gas_appliance", label: "It's a gas appliance and I can smell gas", severity: "emergency" },
      { key: "leaking", label: "It's leaking water onto the floor", severity: "urgent" },
      { key: "fridge", label: "The fridge or freezer is off and food is spoiling", severity: "urgent" },
      { key: "other", label: "An appliance has stopped working", severity: "normal" },
    ],
  },
  {
    key: "locks", label: "Doors, locks & windows", trade: "locksmith",
    blurb: "Locks, keys, broken doors or windows",
    options: [
      { key: "cannot_secure", label: "I can't lock or secure the place", severity: "emergency" },
      { key: "locked_out", label: "I'm locked out", severity: "urgent" },
      { key: "broken_glass", label: "There's broken glass", severity: "urgent" },
      { key: "other", label: "A door, lock or window needs fixing", severity: "normal" },
    ],
  },
  {
    key: "structural", label: "Roof, walls & floors", trade: "general",
    blurb: "Leaks from above, damp, ceilings, steps, railings",
    options: [
      { key: "water_ceiling", label: "Water is coming through a ceiling or light fitting", severity: "emergency" },
      { key: "collapse", label: "A ceiling, stair or railing isn't safe to use", severity: "emergency" },
      { key: "damp", label: "There's damp, staining or mould", severity: "normal" },
      { key: "other", label: "Something else with the building", severity: "normal" },
    ],
  },
  {
    key: "pest", label: "Pests", trade: "pest",
    blurb: "Insects, rodents, wasps",
    options: [
      { key: "infestation", label: "Rodents, or wasps or bees inside", severity: "urgent" },
      { key: "recurring", label: "It was reported before and it's back", severity: "urgent" },
      { key: "other", label: "Insects or pests", severity: "normal" },
    ],
  },
  {
    key: "other", label: "Something else", trade: "general",
    blurb: "Anything not on this list",
    options: [
      { key: "unsafe", label: "Something here isn't safe for the people living here", severity: "emergency" },
      { key: "other", label: "Something else needs fixing", severity: "normal" },
    ],
  },
];

export function category(key) {
  return CATEGORIES.find((c) => c.key === key) || null;
}

/* One choice in, severity out. Returns the option's own wording as the reason,
   so a manager sees what the tenant actually said rather than a bare label. */
export function assess(categoryKey, choiceKey) {
  const cat = category(categoryKey);
  const option = cat ? cat.options.find((o) => o.key === choiceKey) : null;
  if (!option) return { severity: "normal", reasons: [], choice: null };
  return {
    severity: option.severity,
    reasons: option.severity === "normal" ? [] : [option.label],
    choice: option,
  };
}
