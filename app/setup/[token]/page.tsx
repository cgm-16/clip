import { SetupFlow } from './SetupFlow';

export default async function SetupPage({ params }: PageProps<'/setup/[token]'>) {
  const { token } = await params;
  return <SetupFlow token={token} />;
}
