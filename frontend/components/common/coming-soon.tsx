import { Construction } from 'lucide-react';
import { PageHeader } from './page-header';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Placeholder for screens whose backend exists but whose UI is scheduled for a
 * later frontend pass — keeps the app shell navigable end to end meanwhile.
 */
export function ComingSoon({ title, description, note }: { title: string; description?: string; note?: string }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Construction className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">This screen isn’t built yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {note ?? 'It’s scheduled for an upcoming frontend pass.'}
          </p>
        </CardContent>
      </Card>
    </>
  );
}
