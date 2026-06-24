import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Bot,
  Braces,
  CirclePlay,
  GitBranch,
  Moon,
  PanelsTopLeft,
  Plus,
  Route,
  Settings2,
  Sparkles,
  Sun,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type ColorScheme = 'dark' | 'light'

type AgentNodeData = {
  label: string
  description: string
  kind: 'planner' | 'executor' | 'reviewer' | 'custom'
  status: 'ready' | 'running' | 'review'
}

const starterAgents = [
  {
    id: 'planner',
    label: 'Planner Agent',
    description: 'Break goals into executable work plans.',
    kind: 'planner',
    status: 'ready',
    x: 80,
    y: 80,
  },
  {
    id: 'executor',
    label: 'Executor Agent',
    description: 'Run tasks and report structured results.',
    kind: 'executor',
    status: 'running',
    x: 440,
    y: 80,
  },
  {
    id: 'reviewer',
    label: 'Reviewer Agent',
    description: 'Check outputs, risks, and missing context.',
    kind: 'reviewer',
    status: 'review',
    x: 260,
    y: 280,
  },
] as const satisfies Array<
  AgentNodeData & {
    id: string
    x: number
    y: number
  }
>

const initialNodes: Node<AgentNodeData>[] = starterAgents.map((agent) => ({
  id: agent.id,
  type: 'agent',
  position: { x: agent.x, y: agent.y },
  data: {
    label: agent.label,
    description: agent.description,
    kind: agent.kind,
    status: agent.status,
  },
}))

const initialEdges: Edge[] = [
  {
    id: 'planner-to-executor',
    source: 'planner',
    target: 'executor',
    animated: true,
    label: 'plan',
  },
  {
    id: 'executor-to-reviewer',
    source: 'executor',
    target: 'reviewer',
    label: 'result',
  },
]

const statusLabels: Record<AgentNodeData['status'], string> = {
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
}

const kindClassNames: Record<AgentNodeData['kind'], string> = {
  planner: 'border-blue-500/70 bg-blue-500/10',
  executor: 'border-emerald-500/70 bg-emerald-500/10',
  reviewer: 'border-violet-500/70 bg-violet-500/10',
  custom: 'border-orange-500/70 bg-orange-500/10',
}

function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData>>) {
  return (
    <div
      className={cn(
        'min-w-[240px] rounded-lg border bg-card px-4 py-3 shadow-sm transition',
        kindClassNames[data.kind],
        selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background'
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-background !bg-muted-foreground"
      />
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{data.label}</div>
            <div className="text-[11px] uppercase tracking-normal text-muted-foreground">
              {data.kind}
            </div>
          </div>
        </div>
        <Badge variant="secondary" className="h-5 shrink-0">
          {statusLabels[data.status]}
        </Badge>
      </div>
      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
        {data.description}
      </p>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-background !bg-primary"
      />
    </div>
  )
}

const nodeTypes = {
  agent: AgentNode,
}

function App() {
  const [nodes, setNodes] = useState<Node<AgentNodeData>[]>(initialNodes)
  const [edges, setEdges] = useState<Edge[]>(initialEdges)
  const [nextNodeIndex, setNextNodeIndex] = useState(1)
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => {
    if (typeof window === 'undefined') {
      return 'dark'
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  })
  const isElectron = useMemo(() => Boolean(window.orrery), [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', colorScheme === 'dark')
  }, [colorScheme])

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((currentEdges) =>
        addEdge({ ...connection, animated: true }, currentEdges)
      ),
    []
  )
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<AgentNodeData>>[]) =>
      setNodes((currentNodes) => applyNodeChanges(changes, currentNodes)),
    []
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) =>
      setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges)),
    []
  )

  function addAgentNode() {
    const id = `agent-${Date.now()}`
    const index = nextNodeIndex

    setNextNodeIndex((current) => current + 1)
    setNodes((currentNodes) => [
      ...currentNodes,
      {
        id,
        type: 'agent',
        position: { x: 180 + index * 36, y: 180 + index * 28 },
        data: {
          label: `New Agent ${index}`,
          description: 'Configure role, tools, inputs, and outputs.',
          kind: 'custom',
          status: 'ready',
        },
      },
    ])
  }

  return (
    <TooltipProvider>
      <main className="flex h-screen min-h-[720px] overflow-hidden bg-background text-foreground">
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-border bg-sidebar">
          <header
            className={cn(
              'app-region-drag space-y-4 px-5 pb-4 pt-5',
              isElectron && 'pt-16'
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-background">
                  <PanelsTopLeft className="size-4" />
                </div>
                <div>
                  <h1 className="text-base font-semibold tracking-normal">
                    Orrery
                  </h1>
                  <p className="text-xs text-muted-foreground">
                    Agent canvas workspace
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="h-6">
                alpha
              </Badge>
            </div>

            <Button
              className="app-region-no-drag w-full justify-start"
              onClick={addAgentNode}
            >
              <Plus className="size-4" />
              Add agent node
            </Button>
          </header>

          <Separator />

          <section className="flex-1 overflow-y-auto px-3 py-4">
            <div className="mb-3 flex items-center justify-between px-2">
              <h2 className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
                Starter agents
              </h2>
              <Badge variant="secondary">{starterAgents.length}</Badge>
            </div>

            <div className="space-y-2">
              {starterAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="w-full rounded-lg border border-border bg-background/60 p-3 text-left transition hover:bg-accent"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <Bot className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{agent.label}</span>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {agent.description}
                  </p>
                </button>
              ))}
            </div>
          </section>

          <Separator />

          <footer className="grid grid-cols-4 gap-2 p-3">
            {[
              { icon: Route, label: 'Routing' },
              { icon: GitBranch, label: 'Flows' },
              { icon: Braces, label: 'Schemas' },
              { icon: Settings2, label: 'Settings' },
            ].map((item) => (
              <Tooltip key={item.label}>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={item.label}>
                    <item.icon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{item.label}</TooltipContent>
              </Tooltip>
            ))}
          </footer>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="gap-1.5">
                <Sparkles className="size-3" />
                Agent graph
              </Badge>
              <p className="text-sm text-muted-foreground">
                Connect agents, move nodes, and model execution paths.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Switch to ${
                      colorScheme === 'dark' ? 'light' : 'dark'
                    } mode`}
                    onClick={() =>
                      setColorScheme((current) =>
                        current === 'dark' ? 'light' : 'dark'
                      )
                    }
                  >
                    {colorScheme === 'dark' ? (
                      <Sun className="size-4" />
                    ) : (
                      <Moon className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}
                </TooltipContent>
              </Tooltip>

              <Button variant="outline" size="sm">
                <CirclePlay className="size-4" />
                Run graph
              </Button>
            </div>
          </header>

          <div className="relative min-h-0 flex-1">
            <ReactFlow
              colorMode={colorScheme}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              fitView
              fitViewOptions={{ padding: 0.24 }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1.2}
              />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
        </section>
      </main>
    </TooltipProvider>
  )
}

export default App
