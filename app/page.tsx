// Clip has no public landing page in P0. Every surface is either a Discord
// interaction or an admin route behind a short-lived session. This exists so
// the root path is not a 404 for anyone who finds the domain.
export default function Home() {
  return <main>Clip</main>;
}
