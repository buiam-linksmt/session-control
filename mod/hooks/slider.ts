// The drag strategy's scroll bar of one panel section (option desktopPaneScroll `drag`), a Client surface module: it
// draws the bar as the panel draws it (core.ts scrollbar) and posts the move the person asks, which the panel's
// ui.message hook applies. Self-contained: a surface module runs on the surface, apart from the hooks module.
import type { ClientKeyEvent, ClientModule, ClientPointerEvent } from 'claude-code'

/** What the panel hands the slider of one section: the section, its rows, the rows it shows, the first row shown. */
export type SliderProps = { id: string; total: number; visible: number; from: number }
/** While a button is held: the row of the thumb the pointer holds. */
type SliderState = { grab?: number }

const Slider: ClientModule<SliderProps, SliderState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const rows = Math.max(1, props.visible)
  const max = Math.max(0, props.total - props.visible)
  const thumb = max === 0 ? rows : Math.max(1, Math.round((props.visible * props.visible) / props.total))
  const room = rows - thumb
  const from = Math.min(Math.max(0, props.from), max)
  const top = max === 0 || room <= 0 ? 0 : Math.round((from / max) * room)
  // The first row shown when the thumb's top stands at a row of the bar.
  const fromAt = (thumbTop: number) => (room <= 0 ? 0 : Math.round((Math.min(Math.max(0, thumbTop), room) / room) * max))
  surface.onPointer((event: ClientPointerEvent) => {
    if (max === 0) return
    if (event.type === 'down' && event.button === 'left') {
      // Taken on the thumb, it is held at that row; on the track, the thumb's middle comes under the pointer.
      const grab = event.y >= top && event.y < top + thumb ? event.y - top : Math.floor(thumb / 2)
      surface.setState({ grab })
      surface.post({ id: props.id, from: fromAt(event.y - grab) })
    } else if (event.type === 'move' && event.button === 'left' && surface.state?.grab !== undefined) {
      surface.post({ id: props.id, from: fromAt(event.y - surface.state.grab) })
    } else if (event.type === 'up' && surface.state?.grab !== undefined) {
      surface.setState({})
    }
  })
  // After a click on the bar: the arrow keys move a row, the page keys a window less a row, home and end to either end.
  surface.onKey((event: ClientKeyEvent) => {
    if (max === 0) return
    const page = Math.max(1, props.visible - 1)
    const by = ({ up: -1, down: 1, pageup: -page, pagedown: page } as Record<string, number | undefined>)[event.key]
    if (event.key === 'home') surface.post({ id: props.id, from: 0 })
    else if (event.key === 'end') surface.post({ id: props.id, from: max })
    else if (by !== undefined) surface.post({ id: props.id, by })
  })
  const bar = Array.from({ length: rows }, (_, i) => (max === 0 ? ' ' : i >= top && i < top + thumb ? '┃' : '│'))
  return Box({ flexDirection: 'column', width: 1, children: bar.map(ch => Text({ dimColor: true, children: [ch] })) })
}

export default Slider
