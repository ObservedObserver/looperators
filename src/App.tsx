import { useRef } from 'react'
import {
  Bot,
  Braces,
  CirclePlay,
  GitBranch,
  PanelsTopLeft,
  Plus,
  Route,
  Settings2,
  Sparkles,
} from 'lucide-react'
import {
  Tldraw,
  createShapeId,
  toRichText,
  type Editor,
  type TLGeoShape,
  type TLShapeId,
  type TLShapePartial,
} from 'tldraw'
import 'tldraw/tldraw.css'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const starterAgents = [
  {
    id: 'planner',
    label: 'Planner Agent',
    description: 'Break goals into executable work plans.',
    color: 'blue',
    x: 120,
    y: 120,
  },
  {
    id: 'executor',
    label: 'Executor Agent',
    description: 'Run tasks and report structured results.',
    color: 'green',
    x: 440,
    y: 120,
  },
  {
    id: 'reviewer',
    label: 'Reviewer Agent',
    description: 'Check outputs, risks, and missing context.',
    color: 'violet',
    x: 280,
    y: 320,
  },
] as const

function buildAgentShape(
  id: string,
  label: string,
  x: number,
  y: number,
  color: TLGeoShape['props']['color']
): TLShapePartial<TLGeoShape> & { id: TLShapeId } {
  return {
    id: createShapeId(id),
    type: 'geo',
    x,
    y,
    props: {
      geo: 'rectangle',
      w: 220,
      h: 88,
      dash: 'solid',
      url: '',
      growY: 0,
      scale: 1,
      labelColor: 'black',
      color,
      fill: 'semi',
      size: 'm',
      font: 'sans',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(label),
    },
    meta: {
      kind: 'agent',
    },
  }
}

function seedCanvas(editor: Editor) {
  if (editor.getCurrentPageShapes().length > 0) {
    return
  }

  const shapes = starterAgents.map((agent) =>
    buildAgentShape(agent.id, agent.label, agent.x, agent.y, agent.color)
  )

  editor.createShapes(shapes)
  editor.select(...shapes.map((shape) => shape.id))
  editor.zoomToSelection({ animation: { duration: 220 } })
}

function App() {
  const editorRef = useRef<Editor | null>(null)
  const nextNodeIndex = useRef(1)

  function addAgentNode() {
    const editor = editorRef.current

    if (!editor) {
      return
    }

    const index = nextNodeIndex.current++
    const shape = buildAgentShape(
      `agent-${Date.now()}`,
      `New Agent ${index}`,
      180 + index * 32,
      180 + index * 24,
      'orange'
    )

    editor.createShapes([shape])
    editor.select(shape.id)
  }

  return (
    <TooltipProvider>
      <main className="dark flex h-screen min-h-[720px] overflow-hidden bg-background text-foreground">
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-border bg-sidebar">
          <header className="space-y-4 px-5 pb-4 pt-5">
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

            <Button className="w-full justify-start" onClick={addAgentNode}>
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
                Local canvas
              </Badge>
              <p className="text-sm text-muted-foreground">
                Drag, zoom, select, and compose agent nodes.
              </p>
            </div>

            <Button variant="outline" size="sm">
              <CirclePlay className="size-4" />
              Run graph
            </Button>
          </header>

          <div className="relative min-h-0 flex-1">
            <Tldraw
              persistenceKey="orrery-agent-canvas"
              onMount={(editor) => {
                editorRef.current = editor
                seedCanvas(editor)
              }}
            />
          </div>
        </section>
      </main>
    </TooltipProvider>
  )
}

export default App
