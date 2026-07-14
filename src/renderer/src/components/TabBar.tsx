import type { JSX } from 'react'
import type { Tab } from '../state'

interface Props {
  tabs: Tab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
}

const TYPE_ICON: Record<Tab['type'], string> = {
  request: '',
  websocket: 'WS ',
  workflow: '▶ ',
  grpc: 'gRPC ',
  mqtt: 'MQTT ',
  mcp: 'MCP '
}

export default function TabBar(props: Props): JSX.Element {
  return (
    <div className="tabbar">
      {props.tabs.map((tab) => (
        <div
          key={tab.id}
          className={'tab' + (tab.id === props.activeId ? ' tab-active' : '')}
          title={tab.path}
          onClick={() => props.onActivate(tab.id)}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              props.onClose(tab.id)
            }
          }}
        >
          <span className="tab-name">
            {TYPE_ICON[tab.type]}
            {tab.name}
          </span>
          {tab.dirty && <span className="tab-dirty" title="Unsaved changes" />}
          <button
            className="tab-close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation()
              props.onClose(tab.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
