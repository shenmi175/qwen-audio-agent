import { useEffect, useRef } from 'react'

// A live cloud field rather than a video or image, so conversation states can
// change its motion without loading assets or opening another audio stream.
export default function WebCloudOrb({ state = 'idle', motion = 'system' }) {
  const canvas = useRef(null)
  const currentState = useRef(state)
  useEffect(() => { currentState.current = state }, [state])
  useEffect(() => {
    const element = canvas.current
    const context = element.getContext('2d', { alpha: true })
    if (!context) return
    const field = document.createElement('canvas')
    field.width = field.height = 96
    const fieldContext = field.getContext('2d')
    if (!fieldContext) return
    const pixels = fieldContext.createImageData(96, 96)
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    const paused = () => motion === 'off' || (motion !== 'on' && reducedMotion.matches)
    let frame = 0, phase = 0, previous = null, lastPaint = 0, visible = true
    const draw = () => {
      const width = element.width
      context.clearRect(0, 0, width, width)
      for (let row = 0; row < 96; row++) {
        const y = row / 95 * 2 - 1
        for (let column = 0; column < 96; column++) {
          const x = column / 95 * 2 - 1
          const u = x * 2.8 + .6 * Math.sin(y * 2.4 + phase * .48) - phase * .48
          const v = y * 2.6 + .55 * Math.cos(x * 2.8 - phase * .4) + phase * .25
          const cloud = Math.sin(u + Math.sin(v * 1.3)) * .52
            + Math.cos(v * 1.5 - Math.sin(u * .9 + phase * .23)) * .32
            + Math.sin(u * 1.7 + v * .8 - phase * .19) * .16
          const blue = Math.max(0, Math.min(1, (cloud + .28) * 1.3))
          const cyan = Math.max(0, Math.sin(v + phase * .18)) * blue
          const offset = (row * 96 + column) * 4
          pixels.data[offset] = 244 - blue * 177 - cyan * 12
          pixels.data[offset + 1] = 249 - blue * 79 + cyan * 23
          pixels.data[offset + 2] = 255 - blue * 20
          pixels.data[offset + 3] = 255
        }
      }
      fieldContext.putImageData(pixels, 0, 0)
      const breathing = paused() ? 1 : 1 + Math.sin(phase) * .035
      const radius = width * .474 * breathing
      context.save()
      context.beginPath()
      context.arc(width / 2, width / 2, radius, 0, Math.PI * 2)
      context.clip()
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(field, width / 2 - radius, width / 2 - radius, radius * 2, radius * 2)
      const light = context.createRadialGradient(width * .3, width * .22, 0, width * .4, width * .4, width * .7)
      light.addColorStop(0, '#ffffff55')
      light.addColorStop(1, '#ffffff00')
      context.fillStyle = light
      context.fillRect(0, 0, width, width)
      context.restore()
    }
    const animate = time => {
      if (document.hidden || !visible || paused()) { frame = 0; previous = null; return }
      const elapsed = time - lastPaint
      if (elapsed >= 1000 / 30) {
        const speed = { speaking: 1.75, listening: 1.4, processing: 1.55, connecting: 1.15 }[currentState.current] || 1.15
        phase += previous === null ? 0 : Math.min((time - previous) / 1000, .15) * speed
        previous = time
        lastPaint = time - elapsed % (1000 / 30)
        draw()
      }
      frame = requestAnimationFrame(animate)
    }
    const resume = () => {
      draw()
      if (document.hidden || !visible || paused()) {
        cancelAnimationFrame(frame)
        frame = 0
        previous = null
      } else if (!frame) {
        previous = null
        frame = requestAnimationFrame(animate)
      }
    }
    const resize = new ResizeObserver(([entry]) => {
      const width = Math.max(1, Math.round(entry.contentRect.width * Math.min(devicePixelRatio || 1, 2)))
      // Setting canvas.width clears its bitmap. Firefox may notify ResizeObserver
      // again after an intrinsic-size update; never reset a running clock here.
      if (element.width !== width || element.height !== width) element.width = element.height = width
      resume()
    })
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      resume()
    })
    resize.observe(element)
    intersection.observe(element)
    document.addEventListener('visibilitychange', resume)
    reducedMotion.addEventListener('change', resume)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', resume)
      reducedMotion.removeEventListener('change', resume)
    }
  }, [motion])
  return <canvas ref={canvas} className="web-cloud-orb" aria-hidden="true" />
}
