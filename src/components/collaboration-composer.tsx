import { useRef, useState } from 'react';
import { Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import type { CreateCollaborationSessionInput } from '@shared/collaboration';
import type { GraphState } from '@/shared/graph-state';
import { providerReasoningEfforts, providerSupportsReasoningEffort, type ProviderKind } from '@/shared/provider-runtime';
import { AgentRuntimeFields, type AgentRuntimeConfigValue } from '@/components/workflow-form-fields';
import { Button } from '@/components/ui/button';

export const collaborationFieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent-ink/50';
type MemberDraft = AgentRuntimeConfigValue & { key: string; label: string; role: string };
const providerName = (kind: ProviderKind) => (kind === 'claude-code' ? 'Claude' : kind === 'codex' ? 'Codex' : 'Grok');

function nameMembers(members: MemberDraft[]) {
  return members.map((member, index) => {
    const peers = members.filter((item) => item.providerKind === member.providerKind);
    const number = members.slice(0, index + 1).filter((item) => item.providerKind === member.providerKind).length;
    return { ...member, label: `${providerName(member.providerKind)}${peers.length > 1 ? ` ${number}` : ''}` };
  });
}

export function CollaborationComposer({
  runtimeState,
  defaultCwd,
  busy,
  onCreate,
}: {
  runtimeState: GraphState;
  defaultCwd: string;
  busy: boolean;
  onCreate: (input: CreateCollaborationSessionInput) => Promise<void>;
}) {
  const serial = useRef(2);
  const makeMember = (index: number): MemberDraft => {
    const supported = runtimeState.providerInstances.filter((profile) => profile.kind !== 'grok');
    const ready = supported.filter((profile) =>
      Object.values(runtimeState.providerSetupSnapshots ?? {}).some(
        (snapshot) => snapshot.status.providerInstanceId === profile.providerInstanceId && snapshot.status.readiness === 'ready',
      ),
    );
    const profiles = ready.length ? ready : supported;
    const profile = profiles[index % profiles.length];
    const kind = profile?.kind ?? 'codex';
    const efforts = providerReasoningEfforts(kind);
    return {
      key: `member-${index}`,
      label: providerName(kind),
      role: '',
      providerKind: kind,
      providerInstanceId: profile?.providerInstanceId ?? '',
      model: '',
      reasoningEffort: efforts.includes('high') ? 'high' : (efforts[0] ?? 'medium'),
      runtimeMode: 'approval-required',
    };
  };
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState(defaultCwd);
  const [members, setMembers] = useState<MemberDraft[]>(() => nameMembers([makeMember(0), makeMember(1)]));
  const duplicateNames = new Set(members.map((member) => member.label.trim().toLocaleLowerCase())).size !== members.length;
  const valid = cwd.trim() && members.length >= 2 && !duplicateNames && members.every((member) => member.label.trim() && member.providerInstanceId);
  return (
    <form
      className="mx-auto w-full max-w-2xl space-y-6 p-6 sm:p-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        void onCreate({
          title: title.trim() || members.map((member) => member.label.trim()).join(' & '),
          cwd: cwd.trim(),
          members: members.map((member) => ({
            label: member.label.trim(),
            ...(member.role.trim() ? { role: member.role.trim() } : {}),
            providerKind: member.providerKind,
            providerInstanceId: member.providerInstanceId,
            runtimeSettings: {
              runtimeMode: 'approval-required',
              sandbox: 'read-only',
              interactionMode: 'plan',
              ...(member.model.trim() ? { model: member.model.trim() } : {}),
              ...(providerSupportsReasoningEffort(member.providerKind) ? { reasoningEffort: member.reasoningEffort } : {}),
            },
          })),
        });
      }}
    >
      <div className="space-y-2">
        <Users className="size-7 text-accent-ink" />
        <h1 className="text-2xl font-semibold">New group chat</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Chat with your Agents in one place. Use @ to bring someone in, and threads to keep replies together.
        </p>
      </div>
      <label className="block space-y-2 text-sm">
        Chat name <span className="text-muted-foreground">optional</span>
        <input
          autoFocus
          className={collaborationFieldClass}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={members.map((member) => member.label).join(' & ')}
        />
      </label>
      <label className="block space-y-2 text-sm">
        Project folder
        <input required className={collaborationFieldClass} value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/path/to/project" />
      </label>
      <section className="space-y-3" aria-label="Chat members">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Who is joining?</h2>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || members.length >= 8}
            onClick={() =>
              setMembers((current) => {
                const next = makeMember(serial.current++);
                let suffix = 1;
                let label = providerName(next.providerKind);
                while (current.some((member) => member.label.toLocaleLowerCase() === label.toLocaleLowerCase()))
                  label = `${providerName(next.providerKind)} ${++suffix}`;
                return [...current, { ...next, label }];
              })
            }
          >
            <Plus className="size-4" />
            Add Agent
          </Button>
        </div>
        {members.map((member) => (
          <div key={member.key} className="rounded-xl border border-border p-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold">{member.label.slice(0, 1)}</div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{member.label}</p>
                <p className="text-xs text-muted-foreground">
                  {providerName(member.providerKind)} · {member.model || 'Provider default'}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${member.label}`}
                disabled={members.length <= 2 || busy}
                onClick={() => setMembers((current) => current.filter((item) => item.key !== member.key))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-muted-foreground">Customize Agent</summary>
              <div className="space-y-4 pt-4">
                <label className="block space-y-1 text-sm">
                  Name
                  <input
                    required
                    className={collaborationFieldClass}
                    value={member.label}
                    onChange={(event) =>
                      setMembers((current) => current.map((item) => (item.key === member.key ? { ...item, label: event.target.value } : item)))
                    }
                  />
                </label>
                <AgentRuntimeFields
                  hideRuntime
                  comfortable
                  allowedProviderKinds={['claude-code', 'codex']}
                  value={member}
                  idPrefix={member.key}
                  instances={runtimeState.providerInstances.filter((profile) => profile.kind !== 'grok')}
                  modelCatalogs={runtimeState.providerModelCatalogs}
                  onChange={(value) =>
                    setMembers((current) =>
                      current.map((item) =>
                        item.key === member.key
                          ? {
                              ...item,
                              ...value,
                              ...(item.providerKind !== value.providerKind && /^Claude(?: \d+)?$|^Codex(?: \d+)?$/.test(item.label)
                                ? {
                                    label: `${providerName(value.providerKind)} ${current.filter((peer) => peer.key !== item.key && peer.providerKind === value.providerKind).length + 1}`,
                                  }
                                : {}),
                            }
                          : item,
                      ),
                    )
                  }
                />
                <label className="block space-y-1 text-sm">
                  Instructions <span className="text-muted-foreground">optional</span>
                  <textarea
                    className={collaborationFieldClass}
                    rows={2}
                    value={member.role}
                    placeholder="Anything this Agent should keep in mind"
                    onChange={(event) =>
                      setMembers((current) => current.map((item) => (item.key === member.key ? { ...item, role: event.target.value } : item)))
                    }
                  />
                </label>
              </div>
            </details>
          </div>
        ))}
        {duplicateNames ? (
          <p role="alert" className="text-sm text-destructive">
            Give each Agent a different name.
          </p>
        ) : null}
      </section>
      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        Claude and Codex can read the project. Their private chats and tool activity are not shared.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={!valid || busy}>
          {busy ? 'Creating…' : 'Create group chat'}
        </Button>
        <p className="text-xs text-muted-foreground">Agents start only when you send them a message.</p>
      </div>
    </form>
  );
}
