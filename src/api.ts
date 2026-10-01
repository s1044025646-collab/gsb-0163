import { createServer, Server } from 'node:http';
import { SamplingService, ApiError } from './service.ts';

/**
 * Minimal JSON API over node:http. Binds 127.0.0.1 only; port 0 = auto.
 * Error body shape: { error: { code, message } }.
 */
export function createApi(service: SamplingService): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' }).end(s);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const body = method === 'POST' ? await readJson(req) : {};
      const idem = req.headers['idempotency-key'];
      const idemKey = typeof idem === 'string' ? idem : undefined;
      const q = (k: string) => url.searchParams.get(k);
      const page = () => ({
        limit: q('limit') !== null ? Number(q('limit')) : 50,
        offset: q('offset') !== null ? Number(q('offset')) : 0,
      });
      const m = (re: RegExp) => path.match(re);

      let r: RegExpMatchArray | null;
      if (method === 'GET' && path === '/health') {
        send(200, { ok: true });
      } else if (method === 'POST' && path === '/plans') {
        send(201, service.createPlan(body, idemKey));
      } else if (method === 'GET' && path === '/plans') {
        const { limit, offset } = page();
        send(200, service.listPlans(limit, offset));
      } else if (method === 'GET' && (r = m(/^\/plans\/([^/]+)$/))) {
        send(200, service.getPlan(r[1]));
      } else if (method === 'POST' && (r = m(/^\/plans\/([^/]+)\/freeze$/))) {
        send(200, service.freezePlan(r[1]));
      } else if (method === 'GET' && (r = m(/^\/plans\/([^/]+)\/oc$/))) {
        const dMin = q('dMin') !== null ? Number(q('dMin')) : undefined;
        const dMax = q('dMax') !== null ? Number(q('dMax')) : undefined;
        send(200, { points: service.ocScan(r[1], dMin, dMax) });
      } else if (method === 'GET' && (r = m(/^\/plans\/([^/]+)\/risks$/))) {
        if (q('aql') === null || q('lql') === null) {
          throw new ApiError('VALIDATION_ERROR', 'aql and lql query params are required');
        }
        send(200, service.riskCompare(r[1], Number(q('aql')), Number(q('lql'))));
      } else if (method === 'POST' && path === '/batches') {
        send(201, service.createBatch(body, idemKey));
      } else if (method === 'GET' && path === '/batches') {
        const { limit, offset } = page();
        send(200, service.listBatches(limit, offset));
      } else if (method === 'GET' && (r = m(/^\/batches\/([^/]+)$/))) {
        send(200, service.getBatch(r[1]));
      } else if (method === 'GET' && (r = m(/^\/batches\/([^/]+)\/decision$/))) {
        send(200, service.getDecision(r[1]));
      } else if (method === 'POST' && (r = m(/^\/batches\/([^/]+)\/rounds$/))) {
        send(201, service.recordRound(r[1], body.round, body.defectives, body.good, idemKey));
      } else if (method === 'GET' && path === '/records') {
        const { limit, offset } = page();
        send(200, service.listRecords(limit, offset));
      } else {
        throw new ApiError('NOT_FOUND', `${method} ${path} not found`, 404);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        send(e.status, { error: { code: e.code, message: e.message } });
      } else {
        send(400, { error: { code: 'VALIDATION_ERROR', message: (e as Error).message } });
      }
    }
  });
}

function readJson(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new ApiError('VALIDATION_ERROR', 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** Start server bound to localhost on an automatic port. Returns port. */
export async function startApi(service: SamplingService): Promise<{ server: Server; port: number }> {
  const server = createApi(service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, port };
}
