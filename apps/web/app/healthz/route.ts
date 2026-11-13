export function GET() {
  return Response.json({ status: 'ok', component: 'web-shell' }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
