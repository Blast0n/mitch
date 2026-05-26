import { useEffect, useState } from 'react';
import type { JobEvent } from '@/lib/api';

export function useSSE(jobId: string | null): JobEvent[] {
  const [events, setEvents] = useState<JobEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!jobId) return;
    const es = new EventSource(`/api/progress?jobId=${encodeURIComponent(jobId)}`);
    const push = (e: MessageEvent) => {
      try { setEvents(prev => [...prev, JSON.parse(e.data) as JobEvent]); }
      catch { /* ignore malformed */ }
    };
    es.addEventListener('sending', push as EventListener);
    es.addEventListener('stage', push as EventListener);
    es.addEventListener('progress', push as EventListener);
    es.addEventListener('done', (e: MessageEvent) => { push(e); es.close(); });
    return () => es.close();
  }, [jobId]);
  return events;
}
