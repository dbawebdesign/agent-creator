/**
 * Demo data: one agency (Northbeam AI) with a small book of clients, AI employees that have
 * already done a night of work, and one B2B2B resale (Brandlord → Four Corners).
 *
 *   npm run db:seed            (refuses in production unless --force)
 *
 * Logins: aj@northbeam.ai / roster-demo (agency owner) · dana@brandlord.co / roster-demo (client owner)
 */
import { sql } from "drizzle-orm";
import { db, pool, schema } from "./client";
import { hashPassword } from "@/server/security/crypto";
import { nextCronRun } from "@/server/jobs/scheduler";

const PASSWORD = "roster-demo";
const H = 3600_000;
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * H);


async function reset() {
  const tables = Object.values(schema)
    .filter((t): t is typeof schema.users => typeof t === "object" && t !== null && Symbol.for("drizzle:Name") in t)
    .map((t) => (t as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")]);
  await db().execute(sql.raw(`truncate table ${tables.map((t) => `"${t}"`).join(", ")} restart identity cascade`));
}

export async function seed() {
  await reset();
  const d = db();
  const pw = await hashPassword(PASSWORD);

  // --- People ---------------------------------------------------------------
  const [aj, sam, dana, rachel, marcus, lena] = await d
    .insert(schema.users)
    .values([
      { email: "aj@northbeam.ai", name: "AJ Reyes", passwordHash: pw, emailVerifiedAt: new Date() },
      { email: "sam@northbeam.ai", name: "Sam Ortiz", passwordHash: pw, emailVerifiedAt: new Date() },
      { email: "dana@brandlord.co", name: "Dana Whitfield", passwordHash: pw, emailVerifiedAt: new Date() },
      { email: "rachel@coastalpromo.com", name: "Rachel Kim", passwordHash: pw, emailVerifiedAt: new Date() },
      { email: "marcus@summitams.com", name: "Marcus Bell", passwordHash: pw, emailVerifiedAt: new Date() },
      { email: "lena@fourcorners.co", name: "Lena Park", passwordHash: pw, emailVerifiedAt: new Date() },
    ])
    .returning();

  // --- Organizations ---------------------------------------------------------
  const [agency] = await d
    .insert(schema.organizations)
    .values({
      kind: "agency",
      name: "Northbeam AI",
      slug: "northbeam",
      industry: "AI employee agency",
      branding: { displayName: "Northbeam", accent: "#4f46e5", emailFromName: "Northbeam" },
    })
    .returning();
  await d.update(schema.organizations).set({ agencyId: agency!.id }).where(sql`id = ${agency!.id}`);

  const clientRows = await d
    .insert(schema.organizations)
    .values([
      {
        kind: "client",
        parentId: agency!.id,
        agencyId: agency!.id,
        name: "Brandlord",
        slug: "brandlord",
        industry: "Brand & design agency",
        website: "https://brandlord.co",
        branding: { displayName: "Brandlord", accent: "#e11d48", emailFromName: "Brandlord" },
      },
      {
        kind: "client",
        parentId: agency!.id,
        agencyId: agency!.id,
        name: "Coastal Promo Co.",
        slug: "coastal-promo",
        industry: "Promotional products distribution",
        website: "https://coastalpromo.com",
        branding: { displayName: "Coastal Promo", accent: "#0e7490" },
      },
      {
        kind: "client",
        parentId: agency!.id,
        agencyId: agency!.id,
        name: "Summit Agency Software",
        slug: "summit",
        industry: "Insurance agency management software",
        website: "https://summitams.com",
        branding: { displayName: "Summit", accent: "#1d4ed8" },
      },
      {
        kind: "client",
        parentId: agency!.id,
        agencyId: agency!.id,
        name: "Harbor & Pine Law",
        slug: "harbor-pine",
        industry: "Estate planning law firm",
        status: "trial",
        branding: {},
      },
    ])
    .returning();
  const [brandlord, coastal, summit, harbor] = clientRows;

  const [fourCorners] = await d
    .insert(schema.organizations)
    .values({
      kind: "customer",
      parentId: brandlord!.id,
      agencyId: agency!.id,
      name: "Four Corners Coffee",
      slug: "fourcorners",
      industry: "Specialty coffee roaster",
      branding: {},
    })
    .returning();

  await d.insert(schema.memberships).values([
    { userId: aj!.id, orgId: agency!.id, role: "owner" },
    { userId: sam!.id, orgId: agency!.id, role: "admin" },
    { userId: dana!.id, orgId: brandlord!.id, role: "owner" },
    { userId: rachel!.id, orgId: coastal!.id, role: "owner" },
    { userId: marcus!.id, orgId: summit!.id, role: "owner" },
    { userId: lena!.id, orgId: fourCorners!.id, role: "owner" },
  ]);

  // --- Plans & subscriptions (flat rate, no setup fee, no token billing) --------
  const [flat, essentials] = await d
    .insert(schema.plans)
    .values([
      {
        orgId: agency!.id,
        name: "AI Employee",
        description: "Unlimited agents, unlimited usage, a new workflow every week.",
        priceCents: 500_000,
        features: ["Unlimited agents", "Unlimited usage", "New workflow weekly", "Email, SMS, Slack, API & MCP"],
      },
      {
        orgId: agency!.id,
        name: "Assistant Essentials",
        description: "Inbox, calendar and daily briefing for small teams.",
        priceCents: 50_000,
        features: ["1 agent", "Inbox & calendar", "Daily briefing"],
      },
    ])
    .returning();
  const [resalePlan] = await d
    .insert(schema.plans)
    .values({
      orgId: brandlord!.id,
      name: "Brand Studio Assistant",
      description: "Your always-on brand assistant from Brandlord.",
      priceCents: 75_000,
      features: ["Weekly social asset pack", "On-brand copy drafts", "Monthly brand report"],
    })
    .returning();
  await d.insert(schema.subscriptions).values([
    { orgId: brandlord!.id, planId: flat!.id, status: "active", currentPeriodEnd: new Date(now + 18 * 24 * H) },
    { orgId: coastal!.id, planId: flat!.id, status: "active", currentPeriodEnd: new Date(now + 9 * 24 * H) },
    { orgId: summit!.id, planId: flat!.id, status: "active", currentPeriodEnd: new Date(now + 25 * 24 * H) },
    { orgId: harbor!.id, planId: essentials!.id, status: "trialing", currentPeriodEnd: new Date(now + 12 * 24 * H) },
    { orgId: fourCorners!.id, planId: resalePlan!.id, status: "active", currentPeriodEnd: new Date(now + 20 * 24 * H) },
  ]);

  // --- Agents ----------------------------------------------------------------
  const agentRows = await d
    .insert(schema.agents)
    .values([
      {
        orgId: brandlord!.id,
        name: "Maya",
        role: "Brand Asset Producer",
        summary: "Turns client briefs into on-brand social packs, moodboards and status updates.",
        instructions:
          "You produce brand assets for Brandlord's clients. Follow each client's brand guide exactly (colors, type, tone). Deliver finished, reviewable work — never a list of questions. When something is ambiguous, make a sensible choice and note it.",
        status: "active",
        emailHandle: "maya",
        config: { modelTier: "smart", defaultDelivery: ["portal", "email"], requireApprovalFor: ["send_external_email"], voice: "Crisp, upbeat, design-literate." },
        createdBy: aj!.id,
        activatedAt: ago(24 * 41),
      },
      {
        orgId: brandlord!.id,
        name: "Theo",
        role: "Executive Assistant",
        summary: "Runs Dana's inbox and calendar and sends a briefing every morning.",
        instructions:
          "You are Dana's executive assistant. Triage the inbox, draft replies in her voice, protect focus time, and send a short morning briefing before 7 AM.",
        status: "active",
        emailHandle: "theo",
        config: { modelTier: "fast", defaultDelivery: ["portal", "slack"], requireApprovalFor: ["send_external_email"] },
        createdBy: aj!.id,
        activatedAt: ago(24 * 20),
      },
      {
        orgId: coastal!.id,
        name: "Quinn",
        role: "Quoting Specialist",
        summary: "Builds product quote decks from customer requests and keeps supplier pricing current.",
        instructions:
          "You build quotes for Coastal Promo Co. For each request: identify the products, pull current supplier pricing and decoration costs, apply Coastal's margin rules (35% default, 28% for orders over $10k), and produce a branded quote deck plus an invoice draft.",
        status: "active",
        emailHandle: "quinn",
        phoneNumber: "+15125550142",
        config: { modelTier: "smart", defaultDelivery: ["portal", "email"], requireApprovalFor: ["send_external_email"] },
        createdBy: aj!.id,
        activatedAt: ago(24 * 63),
      },
      {
        orgId: summit!.id,
        name: "Atlas",
        role: "Data Migration Specialist",
        summary: "Moves agencies' policy and insured data from competitor systems into Summit overnight.",
        instructions:
          "You migrate insurance agency data from competitor agency-management exports into Summit. Map fields carefully, never drop records silently, and produce a QA report with counts, mismatches and anything needing a human.",
        status: "active",
        emailHandle: "atlas",
        config: { modelTier: "smart", defaultDelivery: ["portal", "slack"], requireApprovalFor: [] },
        computerStatus: "ready",
        computerId: "orgo_cmp_7f3a91",
        createdBy: sam!.id,
        activatedAt: ago(24 * 33),
      },
      {
        orgId: harbor!.id,
        name: "Iris",
        role: "Intake Coordinator",
        summary: "Prepares new-client intake packets and follows up on missing documents.",
        instructions: "You coordinate intake for an estate planning firm. Be precise and discreet.",
        status: "provisioning",
        emailHandle: "iris",
        config: { modelTier: "smart", defaultDelivery: ["portal", "email"], requireApprovalFor: ["send_external_email"] },
        createdBy: aj!.id,
      },
    ])
    .returning();
  const [maya, theo, quinn, atlas, iris] = agentRows;

  const [mayaFc] = await d
    .insert(schema.agents)
    .values({
      orgId: fourCorners!.id,
      sourceAgentId: maya!.id,
      name: "Maya",
      role: "Brand Studio Assistant",
      summary: "Keeps Four Corners' social channels stocked with on-brand assets every week.",
      instructions: maya!.instructions,
      status: "active",
      emailHandle: "maya-fourcorners",
      config: maya!.config,
      createdBy: dana!.id,
      activatedAt: ago(24 * 12),
    })
    .returning();

  // --- Workflows ---------------------------------------------------------------
  const wf = await d
    .insert(schema.workflows)
    .values([
      {
        orgId: brandlord!.id,
        agentId: maya!.id,
        name: "Weekly social asset pack",
        instructions: "Every Monday, produce 12 on-brand social assets per active client with captions and a posting calendar.",
        trigger: { type: "schedule", cron: "0 6 * * 1", timezone: "America/New_York" },
        outputKind: "document",
        deliverTo: ["portal", "email"],
        hoursSavedPerRun: 6,
        lastRunAt: ago(9),
      },
      {
        orgId: brandlord!.id,
        agentId: maya!.id,
        name: "Friday client status email",
        instructions: "Every Friday afternoon, draft a status update to each client summarizing the week's work and next steps.",
        trigger: { type: "schedule", cron: "0 15 * * 5", timezone: "America/New_York" },
        outputKind: "email_draft",
        deliverTo: ["portal"],
        hoursSavedPerRun: 2,
        lastRunAt: ago(5),
      },
      {
        orgId: brandlord!.id,
        agentId: maya!.id,
        name: "Brief to moodboard",
        instructions: "When a client brief arrives by email, produce a moodboard direction with references, palette and type pairing.",
        trigger: { type: "event", event: "email.received" },
        outputKind: "document",
        deliverTo: ["portal", "email"],
        hoursSavedPerRun: 3,
      },
      {
        orgId: brandlord!.id,
        agentId: theo!.id,
        name: "Morning briefing",
        instructions: "Each weekday before 7 AM: today's calendar, the 5 emails that matter, drafts ready to send, and one thing to protect time for.",
        trigger: { type: "schedule", cron: "30 6 * * 1-5", timezone: "America/New_York" },
        outputKind: "report",
        deliverTo: ["portal", "slack"],
        hoursSavedPerRun: 0.75,
        lastRunAt: ago(4),
      },
      {
        orgId: coastal!.id,
        agentId: quinn!.id,
        name: "Quote deck from request",
        instructions: "When a quote request arrives, build a branded quote deck and invoice draft within the hour.",
        trigger: { type: "event", event: "email.received" },
        outputKind: "document",
        deliverTo: ["portal", "email"],
        hoursSavedPerRun: 2.5,
        lastRunAt: ago(7),
      },
      {
        orgId: coastal!.id,
        agentId: quinn!.id,
        name: "Nightly supplier price sync",
        instructions: "Each night, check supplier catalogs for price and stock changes on SKUs quoted in the last 90 days and flag affected open quotes.",
        trigger: { type: "schedule", cron: "0 2 * * *", timezone: "America/New_York" },
        outputKind: "table",
        deliverTo: ["portal"],
        hoursSavedPerRun: 1.5,
        lastRunAt: ago(3),
      },
      {
        orgId: summit!.id,
        agentId: atlas!.id,
        name: "Overnight migration",
        instructions: "Import queued competitor exports into Summit: map fields, dedupe insureds, attach documents, and verify counts.",
        trigger: { type: "schedule", cron: "0 1 * * *", timezone: "America/Chicago" },
        outputKind: "report",
        deliverTo: ["portal", "slack"],
        hoursSavedPerRun: 40,
        lastRunAt: ago(6),
      },
      {
        orgId: fourCorners!.id,
        agentId: mayaFc!.id,
        name: "Weekly social asset pack",
        instructions: "Every Monday, produce 8 on-brand social posts with captions for Four Corners Coffee.",
        trigger: { type: "schedule", cron: "0 6 * * 1", timezone: "America/Denver" },
        outputKind: "document",
        deliverTo: ["portal", "email"],
        hoursSavedPerRun: 4,
        lastRunAt: ago(10),
      },
    ])
    .returning();
  for (const w of wf) {
    if (w.trigger.type === "schedule") {
      await d
        .update(schema.workflows)
        .set({ nextRunAt: nextCronRun(w.trigger.cron, w.trigger.timezone ?? "America/New_York") })
        .where(sql`id = ${w.id}`);
    }
  }
  const [wfSocial, wfFriday, , wfBrief, wfQuote, wfPrice, wfMigrate, wfFc] = wf;

  // --- Runs + deliverables (a night of work) ------------------------------------
  async function delivered(input: {
    org: string;
    agent: string;
    workflow?: string;
    hoursAgo: number;
    title: string;
    preview: string;
    body: string;
    kind?: string;
    hoursSaved: number;
    status?: "new" | "seen" | "approved";
    needsReview?: boolean;
    via?: ("portal" | "email" | "slack" | "sms")[];
    costMicros?: number;
  }) {
    const [run] = await d
      .insert(schema.runs)
      .values({
        orgId: input.org,
        agentId: input.agent,
        workflowId: input.workflow ?? null,
        trigger: input.workflow ? "schedule" : "manual",
        status: input.needsReview ? "waiting_approval" : "succeeded",
        summary: input.preview,
        inputTokens: 18_000 + Math.round(Math.random() * 30_000),
        outputTokens: 2_500 + Math.round(Math.random() * 5_000),
        costMicros: input.costMicros ?? 240_000 + Math.round(Math.random() * 400_000),
        startedAt: ago(input.hoursAgo + 0.2),
        finishedAt: ago(input.hoursAgo),
        createdAt: ago(input.hoursAgo + 0.2),
      })
      .returning();
    await d.insert(schema.runSteps).values([
      { runId: run!.id, seq: 1, kind: "tool_call", name: "knowledge_search", data: { query: input.title } },
      { runId: run!.id, seq: 2, kind: "tool_result", name: "knowledge_search", data: { hits: 6 } },
      { runId: run!.id, seq: 3, kind: "tool_call", name: "create_deliverable", data: { title: input.title } },
    ]);
    await d.insert(schema.usageEvents).values({
      orgId: input.org,
      agencyId: agency!.id,
      agentId: input.agent,
      runId: run!.id,
      kind: "llm",
      model: "claude-opus-5-5",
      inputTokens: run!.inputTokens,
      outputTokens: run!.outputTokens,
      costMicros: run!.costMicros,
      createdAt: ago(input.hoursAgo),
    });
    const [del] = await d
      .insert(schema.deliverables)
      .values({
        orgId: input.org,
        agentId: input.agent,
        runId: run!.id,
        workflowId: input.workflow ?? null,
        title: input.title,
        kind: input.kind ?? "report",
        preview: input.preview,
        body: input.body,
        status: input.status ?? "new",
        needsReview: input.needsReview ?? false,
        deliveredVia: input.via ?? ["portal"],
        hoursSaved: input.hoursSaved,
        createdAt: ago(input.hoursAgo),
        seenAt: input.status === "seen" || input.status === "approved" ? ago(input.hoursAgo - 1) : null,
      })
      .returning();
    return { run: run!, deliverable: del! };
  }

  await delivered({
    org: brandlord!.id,
    agent: maya!.id,
    workflow: wfSocial!.id,
    hoursAgo: 9,
    title: "Four Corners — November social pack",
    preview: "12 posts across Instagram and LinkedIn, captions written, scheduled Nov 3–16.",
    kind: "document",
    hoursSaved: 6,
    via: ["portal", "email"],
    body: `## November social pack · Four Corners Coffee

Twelve posts built from the fall brand refresh. Palette and type follow the brand guide v3 (Clay #B4532A, Oat #F3E9DC, Roast #2B1D16; Söhne + Tiempos).

| # | Date | Channel | Concept | Caption |
|---|---|---|---|---|
| 1 | Nov 3 | Instagram | Harvest blend hero | First pour of the Harvest blend. Notes of fig, cocoa and a long, warm finish. |
| 2 | Nov 4 | LinkedIn | Roaster spotlight | Meet Ana, who has dialed in every roast profile since 2019. |
| 3 | Nov 5 | Instagram | Latte art reel | Thirty seconds of slow, satisfying foam. |
| 4 | Nov 7 | Instagram | Wholesale partners | Now pouring at six new cafés across Denver. |
| 5 | Nov 10 | LinkedIn | Sourcing story | Direct trade with the Rivera family farm in Huila, year five. |
| 6 | Nov 12 | Instagram | Holiday gift box teaser | Something cozy is coming on the 18th. |

…and six more in the attached board.

**Choices I made:** Used the warmer Clay accent for harvest posts to separate them from the evergreen series. Kept captions under 140 characters for mobile.

**Needs you:** nothing. Approve and I'll queue them in Buffer.`,
  });

  const friday = await delivered({
    org: brandlord!.id,
    agent: maya!.id,
    workflow: wfFriday!.id,
    hoursAgo: 5,
    title: "Draft: weekly status to Four Corners",
    preview: "Ready to send to Lena — covers the social pack, the gift box packaging, and next week.",
    kind: "email_draft",
    hoursSaved: 1,
    needsReview: true,
    body: `**To:** Lena Park <lena@fourcorners.co>
**Subject:** Four Corners · week of Oct 27

Hi Lena,

Quick wrap on the week:

- **Social pack:** all 12 November posts are designed and captioned. They go live Nov 3.
- **Gift box packaging:** dielines are with the printer; proofs arrive Wednesday.
- **Next week:** wholesale one-pager refresh and the Harvest blend landing page.

Nothing needed from you unless you'd like to swap any of the post dates.

Best,
Maya at Brandlord`,
  });
  await d.insert(schema.approvals).values({
    orgId: brandlord!.id,
    agentId: maya!.id,
    runId: friday.run.id,
    action: "send_external_email",
    description: "Send the weekly status email to Lena Park (lena@fourcorners.co)",
    payload: { to: "lena@fourcorners.co", subject: "Four Corners · week of Oct 27", deliverableId: friday.deliverable.id },
  });

  await delivered({
    org: brandlord!.id,
    agent: theo!.id,
    workflow: wfBrief!.id,
    hoursAgo: 4,
    title: "Your morning briefing",
    preview: "3 meetings, 2 replies drafted, and the Four Corners proofs land at 2 PM.",
    hoursSaved: 0.75,
    via: ["portal", "slack"],
    status: "seen",
    body: `### Today
- **10:00** Pitch review with the Halden team (prep doc attached)
- **1:00** Lunch with Priya (Kindred Bakery) — she asked about a spring rebrand
- **2:00** Four Corners packaging proofs arrive

### Replies drafted for you
1. **Halden** — confirming the revised timeline (ready to send)
2. **Printer** — approving the paper stock upgrade (+$140)

### Protect
Block 3–5 PM for the Kindred proposal; I moved the vendor call to Thursday.`,
  });

  await delivered({
    org: coastal!.id,
    agent: quinn!.id,
    workflow: wfQuote!.id,
    hoursAgo: 7,
    title: "Quote deck: Lakeside Credit Union — 250 onboarding kits",
    preview: "3 kit options from $38.40 to $61.75 per kit, invoice draft attached.",
    kind: "document",
    hoursSaved: 2.5,
    via: ["portal", "email"],
    body: `## Lakeside Credit Union · New member onboarding kits

Request from **Jordan Ellis** (Oct 31): 250 kits, delivered by Dec 1, branded with the new Lakeside logo.

| Option | Contents | Per kit | Total (250) | Margin |
|---|---|---|---|---|
| Essentials | Tumbler, notebook, pen, sticker | $38.40 | $9,600 | 35% |
| Classic | + Canvas tote, phone stand | $49.90 | $12,475 | 28% |
| Premium | + Fleece quarter-zip, gift box | $61.75 | $15,438 | 28% |

**Supplier pricing** pulled from SanMar and Gemline this morning. Decoration: 1-color screen print, 2-color on the tote.

**Lead time:** 12 business days after proof approval. Ordering by **Nov 10** hits Dec 1.

Invoice draft for the Classic option is ready in QuickBooks (not sent).`,
  });

  await delivered({
    org: coastal!.id,
    agent: quinn!.id,
    workflow: wfPrice!.id,
    hoursAgo: 3,
    title: "Overnight price changes: 14 SKUs, 3 open quotes affected",
    preview: "SanMar raised fleece prices 6%. Two quotes need a refresh before Wednesday.",
    kind: "table",
    hoursSaved: 1.5,
    body: `| SKU | Supplier | Was | Now | Change | Open quotes |
|---|---|---|---|---|---|
| F217 Fleece ¼-zip | SanMar | $22.10 | $23.43 | +6.0% | Lakeside CU, Ridgeway HS |
| 1624 Tote | Gemline | $6.85 | $6.85 | — | — |
| TM1 Tumbler 20oz | Gemline | $9.40 | $9.12 | −3.0% | Lakeside CU |
| JN-400 Notebook | Leed's | $4.95 | $5.20 | +5.1% | Brightline Dental |

**Recommendation:** refresh the Lakeside Premium option (+$0.33/kit) and Brightline (+$0.25/kit) before they're accepted. Ridgeway is still inside your 5% buffer.`,
  });

  await delivered({
    org: summit!.id,
    agent: atlas!.id,
    workflow: wfMigrate!.id,
    hoursAgo: 6,
    title: "Migration complete: Hartwell Insurance — 3,412 policies",
    preview: "All records imported from the AgencyPro export. 17 need a human look.",
    hoursSaved: 40,
    via: ["portal", "slack"],
    status: "approved",
    costMicros: 14_200_000,
    body: `## Hartwell Insurance · AgencyPro → Summit

| Object | In export | Imported | Merged dupes | Needs review |
|---|---|---|---|---|
| Insureds | 2,184 | 2,171 | 13 | 0 |
| Policies | 3,412 | 3,412 | 0 | 9 |
| Documents | 11,906 | 11,898 | 0 | 8 |

**Needs review (17):** 9 policies with an effective date after expiration (likely typos in the source), 8 PDFs that were password-protected.

Finished at 4:52 AM. Hartwell can log in this morning — their old vendor quoted $10,000 for this.`,
  });

  await delivered({
    org: fourCorners!.id,
    agent: mayaFc!.id,
    workflow: wfFc!.id,
    hoursAgo: 10,
    title: "Your November social posts are ready",
    preview: "8 posts with captions, scheduled for the first two weeks of November.",
    kind: "document",
    hoursSaved: 4,
    via: ["portal", "email"],
    body: `Eight posts for the first half of November, built on your fall palette.

1. **Harvest blend hero** — Nov 3
2. **Meet Ana, head roaster** — Nov 4
3. **Latte art reel** — Nov 5
4. **Six new wholesale partners** — Nov 7
5. **Rivera family farm, year five** — Nov 10
6. **Gift box teaser** — Nov 12
7. **Brew guide: Chemex** — Nov 14
8. **Weekend hours** — Nov 15

Reply with any changes, or approve and they'll go out on schedule.`,
  });

  // --- Memory, knowledge, conversations ----------------------------------------
  await d.insert(schema.memories).values([
    { orgId: brandlord!.id, agentId: maya!.id, kind: "preference", content: "Dana prefers captions under 140 characters and no emoji in LinkedIn posts.", importance: 4, source: "feedback" },
    { orgId: brandlord!.id, agentId: maya!.id, kind: "person", content: "Lena Park is the marketing lead at Four Corners Coffee; she approves social content.", importance: 4 },
    { orgId: brandlord!.id, agentId: maya!.id, kind: "fact", content: "Four Corners brand guide v3: Clay #B4532A, Oat #F3E9DC, Roast #2B1D16; Söhne + Tiempos.", importance: 5 },
    { orgId: coastal!.id, agentId: quinn!.id, kind: "fact", content: "Margin rules: 35% default, 28% on orders above $10,000.", importance: 5, source: "discovery" },
    { orgId: coastal!.id, agentId: quinn!.id, kind: "preference", content: "Rachel wants three good-better-best options on every quote.", importance: 4, source: "discovery" },
    { orgId: summit!.id, agentId: atlas!.id, kind: "fact", content: "AgencyPro exports encode policy status as numeric codes; 7 = cancelled flat.", importance: 4 },
  ]);

  const [kbBrand, kbMargin] = await d
    .insert(schema.knowledgeSources)
    .values([
      { orgId: brandlord!.id, agentId: maya!.id, title: "Four Corners brand guide v3", kind: "text", status: "ready", chunkCount: 1 },
      { orgId: coastal!.id, agentId: quinn!.id, title: "Coastal pricing & margin policy", kind: "text", status: "ready", chunkCount: 1 },
      { orgId: summit!.id, agentId: atlas!.id, title: "AgencyPro field mapping", kind: "text", status: "ready", chunkCount: 0 },
    ])
    .returning();
  await d.insert(schema.knowledgeChunks).values([
    { orgId: brandlord!.id, sourceId: kbBrand!.id, agentId: maya!.id, seq: 0, content: "Four Corners Coffee brand guide v3. Primary palette: Clay #B4532A, Oat #F3E9DC, Roast #2B1D16. Type: Söhne for headlines, Tiempos for body. Voice: warm, unhurried, craft-focused." },
    { orgId: coastal!.id, sourceId: kbMargin!.id, agentId: quinn!.id, seq: 0, content: "Coastal Promo margin policy: apply 35% margin by default; 28% for orders over $10,000. Always present Essentials, Classic and Premium options. Decoration costs: screen print $0.85/color/location." },
  ]);

  const [conv] = await d
    .insert(schema.conversations)
    .values({ orgId: coastal!.id, agentId: quinn!.id, channel: "email", externalThreadId: "<req-8812@lakesidecu.org>", subject: "Onboarding kits for new members" , lastMessageAt: ago(7.5) })
    .returning();
  await d.insert(schema.messages).values([
    { orgId: coastal!.id, conversationId: conv!.id, direction: "inbound", author: "contact", body: "Hi! We need about 250 onboarding kits for new members by Dec 1. Tumbler, notebook, maybe a tote. Can you send options?", deliveryStatus: "received", externalId: "<req-8812@lakesidecu.org>", meta: { from: "jordan.ellis@lakesidecu.org" }, createdAt: ago(7.5) },
    { orgId: coastal!.id, conversationId: conv!.id, direction: "outbound", author: "agent", body: "Thanks Jordan — three kit options are ready for Rachel's review; you'll have them this morning.", deliveryStatus: "sent", externalId: "out-8812-1", createdAt: ago(7.2) },
  ]);

  const [conv2] = await d
    .insert(schema.conversations)
    .values({ orgId: brandlord!.id, agentId: maya!.id, channel: "portal", userId: dana!.id, subject: "Kindred Bakery", lastMessageAt: ago(26) })
    .returning();
  await d.insert(schema.messages).values([
    { orgId: brandlord!.id, conversationId: conv2!.id, direction: "inbound", author: "user", body: "Can you pull together a quick moodboard direction for Kindred Bakery's spring refresh before my lunch with Priya?", deliveryStatus: "received", createdAt: ago(27) },
    { orgId: brandlord!.id, conversationId: conv2!.id, direction: "outbound", author: "agent", body: "On it. You'll have three directions in your portal by 11 — soft pastels, heritage serif, and a bold flour-sack typographic option.", deliveryStatus: "sent", createdAt: ago(26.9) },
  ]);

  await d.insert(schema.channelConnections).values([
    { orgId: brandlord!.id, agentId: null, kind: "slack", externalId: "T0BRANDLORD", status: "connected", config: { teamName: "Brandlord", channel: "#studio" } },
    { orgId: brandlord!.id, agentId: maya!.id, kind: "email", externalId: "maya", status: "connected" },
    { orgId: coastal!.id, agentId: quinn!.id, kind: "sms", externalId: "+15125550142", status: "connected" },
    { orgId: coastal!.id, agentId: quinn!.id, kind: "email", externalId: "quinn", status: "connected" },
    { orgId: summit!.id, agentId: null, kind: "slack", externalId: "T0SUMMIT", status: "connected", config: { teamName: "Summit", channel: "#migrations" } },
  ]);

  const [disc] = await d
    .insert(schema.discoveries)
    .values({
      orgId: harbor!.id,
      title: "Discovery call — Harbor & Pine Law",
      transcript:
        "Owner: Every new client fills out a 14-page intake packet and we chase them for missing documents for weeks. My paralegal spends maybe 10 hours a week on follow-ups.",
      status: "hired",
      agentId: iris!.id,
      createdBy: aj!.id,
    })
    .returning();
  void disc;

  return { agency: agency!, brandlord: brandlord!, fourCorners: fourCorners! };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.NODE_ENV === "production" && !process.argv.includes("--force")) {
    console.error("Refusing to seed in production (pass --force).");
    process.exit(1);
  }
  seed()
    .then(async () => {
      console.log("[seed] done — aj@northbeam.ai / dana@brandlord.co, password: roster-demo");
      await pool().end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await pool().end();
      process.exit(1);
    });
}
