// Liveness probe for k8s and the Wave 0 deployment gate. Deliberately does not
// touch the database: this answers "is the process serving?", not "is every
// dependency healthy?". A probe that fails on a transient DB blip would take
// the Discord interaction endpoint down with it.
export async function GET() {
  return Response.json({ ok: true });
}
