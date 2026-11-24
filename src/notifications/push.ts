export type PushMessage = { to: string; title: string; body: string; data: { path?: string }; channelId: string };
export type PushResult = { to: string; ok: boolean; unregistered: boolean };
/** Never throws: a failed send must not fail the caller. */
export type PushSender = (messages: PushMessage[]) => Promise<PushResult[]>;

export const EXPO_TOKEN = /^Expo(nent)?PushToken\[.+\]$/;

const ENDPOINT = 'https://exp.host/--/api/v2/push/send';
type Ticket = { status?: string; details?: { error?: string } };

export const expoPush: PushSender = async (messages) => {
  const results: PushResult[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = (await res.json()) as { data?: Ticket[] };
      chunk.forEach((m, j) => {
        const t = data?.[j];
        results.push({ to: m.to, ok: t?.status === 'ok', unregistered: t?.details?.error === 'DeviceNotRegistered' });
      });
    } catch (error) {
      console.warn(`[push] send failed: ${error instanceof Error ? error.message : 'unknown'}`);
      for (const m of chunk) results.push({ to: m.to, ok: false, unregistered: false });
    }
  }
  return results;
};
