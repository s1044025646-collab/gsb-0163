import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { migrate } from './db.js';
import { AppError } from './errors.js';
import { Service, paginate } from './service.js';

interface Json {
  [k: string]: unknown;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new AppError('VALIDATION_ERROR', 'request body too large'));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          return reject(new AppError('VALIDATION_ERROR', 'body must be an object'));
        resolve(parsed as Json);
      } catch {
        reject(new AppError('VALIDATION_ERROR', 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function idemKey(body: Json, header: string | undefined): string | null {
  const v = (body.idempotencyKey as string | undefined) ?? header ?? null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startApi(
  db: DatabaseSync,
  opts: { host?: string; port?: number } = {},
): Promise<StartedServer> {
  const host = opts.host ?? '127.0.0.1';
  const service = new Service(db);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (path === '/health' && method === 'GET')
        return send(res, 200, { ok: true });

      const segs = path.split('/').filter(Boolean);

      // /plans
      if (segs[0] === 'plans' && segs.length === 1) {
        if (method === 'GET') {
          const { limit, offset } = paginate(url.searchParams);
          const { items, total } = service.listPlans(limit, offset);
          return send(res, 200, page(items, total, limit, offset));
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const plan = service.createPlan(body.code as string, body as never);
          return send(res, 201, { plan });
        }
      }

      const planById =
        segs[0] === 'plans' && segs.length === 2 ? segs[1] : null;
      if (planById) {
        if (method === 'GET')
          return send(res, 200, { plan: service.getPlan(planById) });
      }

      if (segs[0] === 'plans' && segs[2] === 'oc' && method === 'GET') {
        return send(res, 200, service.oc(segs[1]!));
      }
      if (segs[0] === 'plans' && segs[2] === 'risk' && method === 'GET') {
        const aql = Number(url.searchParams.get('aql'));
        const rql = Number(url.searchParams.get('rql'));
        return send(res, 200, service.risk(segs[1]!, aql, rql));
      }
      if (segs[0] === 'plans' && segs[2] === 'evaluate' && method === 'GET') {
        const K = parseInt(url.searchParams.get('K') ?? '', 10);
        return send(res, 200, service.evaluatePlan(segs[1]!, K));
      }
      if (segs[0] === 'plans' && segs[2] === 'stages' && method === 'GET') {
        const K = parseInt(url.searchParams.get('K') ?? '', 10);
        return send(res, 200, service.stageBreakdown(segs[1]!, K));
      }

      // /records
      if (segs[0] === 'records' && segs.length === 1) {
        if (method === 'GET') {
          const { limit, offset } = paginate(url.searchParams);
          const status = url.searchParams.get('status') ?? undefined;
          const lotRef = url.searchParams.get('lotRef') ?? undefined;
          const r = service.listRecords(limit, offset, status, lotRef);
          return send(res, 200, page(r.items, r.total, limit, offset));
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const r = service.openRecord(
            body.lotRef as string,
            body.planId as string,
            idemKey(body, req.headers['idempotency-key'] as string),
          );
          return send(res, r.created ? 201 : 200, r);
        }
      }
      if (segs[0] === 'records' && segs.length === 2 && method === 'GET') {
        return send(res, 200, { record: service.getRecord(segs[1]!) });
      }
      if (segs[0] === 'records' && segs[2] === 'first' && method === 'POST') {
        const body = await readJson(req);
        const d1 = body.d1 as number;
        const r = service.enterFirst(
          segs[1]!,
          d1,
          idemKey(body, req.headers['idempotency-key'] as string),
        );
        return send(res, r.replay ? 200 : 201, r);
      }
      if (segs[0] === 'records' && segs[2] === 'second' && method === 'POST') {
        const body = await readJson(req);
        const trueK =
          body.trueK === undefined ? undefined : (body.trueK as number);
        const r = service.enterSecond(segs[1]!, body.d2 as number, trueK);
        return send(res, 201, r);
      }
      if (segs[0] === 'records' && segs[2] === 'trace' && method === 'GET') {
        return send(res, 200, service.trace(segs[1]!));
      }
      if (segs[0] === 'records' && segs[2] === 'report' && method === 'POST') {
        const body = await readJson(req);
        const r = service.freezeReport(
          segs[1]!,
          idemKey(body, req.headers['idempotency-key'] as string),
        );
        return send(res, r.created ? 201 : 200, r);
      }

      // /reports
      if (segs[0] === 'reports' && segs.length === 1 && method === 'GET') {
        const { limit, offset } = paginate(url.searchParams);
        const recordId = url.searchParams.get('recordId') ?? undefined;
        const r = service.listReports(limit, offset, recordId);
        return send(res, 200, page(r.items, r.total, limit, offset));
      }
      if (segs[0] === 'reports' && segs.length === 2 && method === 'GET') {
        return send(res, 200, { report: service.reportDetail(segs[1]!) });
      }

      return send(res, 404, { error: { code: 'NOT_FOUND', message: path } });
    } catch (err) {
      return handleError(res, err);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}

function page(items: unknown[], total: number, limit: number, offset: number) {
  return {
    items,
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    hasMore: offset + items.length < total,
  };
}

function handleError(res: import('node:http').ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    const status =
      err.code === 'NOT_FOUND' ||
      err.code === 'PLAN_NOT_FOUND' ||
      err.code === 'RECORD_NOT_FOUND'
        ? 404
        : err.code === 'CONFLICT' || err.code === 'DECISION_FINAL'
          ? 409
          : 400;
    send(res, status, { error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  send(res, 500, {
    error: { code: 'INTERNAL', message: (err as Error).message },
  });
}
