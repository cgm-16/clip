import type {
  ArchiveMessageIds,
  CreateArchiveInput,
  DiscordArchiveGateway,
} from '@/lib/clip/types';

export type DeleteCall = { archiveChannelId: string; ids: ArchiveMessageIds };

export type FakeDiscordArchiveGateway = DiscordArchiveGateway & {
  /** Every create attempt in order, including the ones that threw. */
  readonly createCalls: readonly CreateArchiveInput[];
  readonly deleteCalls: readonly DeleteCall[];
  /** Makes the next `createArchiveMessage` throw `error` instead of posting. */
  failNextCreate(error: Error): void;
  /** Runs `hook` inside the next `deleteArchiveMessage`, before it resolves. */
  onNextDelete(hook: () => Promise<void>): void;
};

/**
 * An in-memory stand-in for the Discord side of the archive.
 *
 * The delete hook is what makes the §9.3 races deterministic: a concurrent
 * clip or author removal executed by the hook lands in exactly the window
 * between "Discord messages deleted" and "the finalizer retakes the lock",
 * which is otherwise only reachable by sleeping and hoping.
 *
 * Id pairs are numbered per gateway instance so a recreated archive is
 * distinguishable from the one that was deleted -- a revival test that
 * cannot tell the two apart proves nothing.
 */
export function createFakeGateway(): FakeDiscordArchiveGateway {
  const createCalls: CreateArchiveInput[] = [];
  const deleteCalls: DeleteCall[] = [];
  let archivesPosted = 0;
  let nextCreateError: Error | null = null;
  let deleteHook: (() => Promise<void>) | null = null;

  return {
    createCalls,
    deleteCalls,

    failNextCreate(error: Error): void {
      nextCreateError = error;
    },

    onNextDelete(hook: () => Promise<void>): void {
      deleteHook = hook;
    },

    async createArchiveMessage(input: CreateArchiveInput): Promise<ArchiveMessageIds> {
      createCalls.push(input);
      if (nextCreateError !== null) {
        const error = nextCreateError;
        nextCreateError = null;
        throw error;
      }
      archivesPosted += 1;
      return {
        provenanceMessageId: `provenance-${archivesPosted}`,
        forwardMessageId: `forward-${archivesPosted}`,
      };
    },

    async deleteArchiveMessage(archiveChannelId: string, ids: ArchiveMessageIds): Promise<void> {
      deleteCalls.push({ archiveChannelId, ids });
      // One-shot: the hook exists to land one concurrent request in the
      // deletion window. A hook that fired again on the delete that the
      // concurrent request itself triggers would recurse.
      const hook = deleteHook;
      deleteHook = null;
      if (hook !== null) {
        await hook();
      }
    },
  };
}
