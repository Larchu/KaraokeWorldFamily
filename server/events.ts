import type { Response } from "express";

type ClientEntry = {
  res: Response;
  authorizedStage: boolean;
};

const clients = new Set<ClientEntry>();

export function registerSseClient(res: Response, authorizedStage: boolean): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const entry: ClientEntry = { res, authorizedStage };
  clients.add(entry);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clients.delete(entry);
      clearInterval(heartbeat);
    }
  }, 15000);

  return () => {
    clearInterval(heartbeat);
    clients.delete(entry);
  };
}

export function sendSseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function broadcastPublicEvent(event: string, data: unknown): void {
  for (const client of clients) {
    try {
      sendSseEvent(client.res, event, data);
    } catch {
      clients.delete(client);
    }
  }
}

export function broadcastStageEvent(event: string, data: unknown): void {
  for (const client of clients) {
    if (!client.authorizedStage) continue;
    try {
      sendSseEvent(client.res, event, data);
    } catch {
      clients.delete(client);
    }
  }
}
