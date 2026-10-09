// Folder view (Inbox/Sent/Drafts/Trash) — screen-flow-inventory.md §2.9 / Flow 9. GET /mailboxes/{mailboxId}/folders/{folder}/messages. Built in Step 2.4 — needs mailbox provisioning (Step 2.3) first.

import { ComingSoon } from '@/components/common/coming-soon';

export default function MailPage() {
  return <ComingSoon title="Mail" note="Webmail needs the self-hosted mail servers (Step 2.1) and the webmail API (Step 2.4). Neither exists yet, so there is nothing to show here." />;
}
