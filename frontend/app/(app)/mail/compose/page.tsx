// Compose/Reply/Forward — screen-flow-inventory.md §2.9 / Flow 8. POST /mailboxes/{mailboxId}/attachments then POST .../messages. This is the entirety of MVP's file-handling flow (no separate file-upload screen — see srs.md §7.7/§7.8).

import { ComingSoon } from '@/components/common/coming-soon';

export default function ComposePage() {
  return <ComingSoon title="Compose" note="Sending mail needs the self-hosted mail servers (Step 2.1) and the webmail API (Step 2.4). Neither exists yet." />;
}
