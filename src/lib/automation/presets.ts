import type { ActionDef, Conditions, TriggerKey } from './engine';

/** Recommended starting set. Always created DISABLED and requiring approval — an admin turns on what they want. */
export const STARTER_AUTOMATIONS: { name: string; trigger: TriggerKey; conditions: Conditions; actions: ActionDef[]; cap: number; cooldown: number }[] = [
  {
    name: 'New client onboarding', trigger: 'client_created', conditions: {}, cap: 25, cooldown: 0,
    actions: [
      { type: 'create_task', title: 'Welcome call: {{client_name}}', body: 'Introduce yourself, confirm contact details and explain the process.', dueInDays: 1 },
      { type: 'request_document', kind: 'id', body: 'A clear photo of your government-issued ID.' },
      { type: 'portal_message', title: 'Welcome', body: 'Hi {{client_first_name}}, welcome! Your specialist will be in touch shortly. You can upload documents and see every update in your portal.' },
    ],
  },
  {
    name: 'Missing document reminder', trigger: 'missing_documents', conditions: { afterDays: 3 }, cap: 25, cooldown: 7,
    actions: [{ type: 'portal_message', title: 'A quick reminder', body: 'Hi {{client_first_name}}, we are still waiting on a document you were asked for. You can upload it in your portal whenever you are ready.' }],
  },
  {
    name: 'Investigation deadline follow-up', trigger: 'dispute_deadline', conditions: { withinDays: 5 }, cap: 50, cooldown: 7,
    actions: [{ type: 'create_task', title: 'Follow up: {{item}} (response due {{due_date}})', body: 'Check for a response and prepare a follow-up letter if none has arrived.', dueInDays: 1 }, { type: 'notify_staff', title: 'Response window closing: {{item}}' }],
  },
  {
    name: 'Dispute submitted — tell the client', trigger: 'dispute_status_changed', conditions: { toStatus: 'submitted' }, cap: 25, cooldown: 0,
    actions: [{ type: 'portal_message', title: 'Your dispute was submitted', body: 'Hi {{client_first_name}}, we submitted your dispute about {{item}}. We will update you when a response arrives.' }],
  },
  {
    name: 'Inactive client alert', trigger: 'client_inactive', conditions: { days: 30 }, cap: 25, cooldown: 30,
    actions: [{ type: 'create_task', title: 'Check in with {{client_name}}', body: 'No activity in 30+ days.', dueInDays: 2 }],
  },
  {
    name: 'Weekly summary', trigger: 'weekly_digest', conditions: {}, cap: 1, cooldown: 7,
    actions: [{ type: 'notify_staff', title: 'Your weekly summary' }],
  },
];
