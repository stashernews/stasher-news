export const SECTIONS = [
  { id: 'overview', label: 'Overview', order: 10, kind: 'overview', groups: [] },
  { id: 'treasury', label: 'Treasury', order: 15, kind: 'treasury', groups: [] },
  { id: 'fees', label: 'Fees & pricing', order: 20, kind: 'settings', groups: ['Posting & replies', 'Tips & downvotes', 'Territories', 'Bounties'] },
  { id: 'trust', label: 'Ranking & trust', order: 30, kind: 'settings', groups: ['Tip ranking', 'Curator trust', 'Trust walk'] },
  { id: 'rewards', label: 'Rewards & budget', order: 40, kind: 'settings', groups: ['Allocation', 'Distribution', 'Curator budget'] },
  { id: 'content', label: 'Content & limits', order: 50, kind: 'settings', groups: ['Spam escalation', 'Free quotas', 'Feed filters', 'Limits', 'Anonymous fees'] },
  { id: 'site', label: 'Site switches', order: 60, kind: 'settings', groups: ['Availability', 'Invite codes', 'Features', 'Operations'] },
  { id: 'access', label: 'Access & security', order: 70, kind: 'access', groups: [] },
  { id: 'environment', label: 'Environment', order: 80, kind: 'environment', groups: [] },
  { id: 'audit', label: 'Audit log', order: 90, kind: 'audit', groups: [] }
]
