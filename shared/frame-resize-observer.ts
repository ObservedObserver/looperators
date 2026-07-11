export type ResizeEntryLike = { target: object }

export type ResizeObserverLike = {
  observe(target: object, options?: unknown): void
  unobserve(target: object): void
  disconnect(): void
}

export type ResizeObserverConstructorLike = new (
  callback: (entries: readonly ResizeEntryLike[], observer: ResizeObserverLike) => void,
) => ResizeObserverLike

export function createFrameResizeObserverClass(
  NativeResizeObserver: ResizeObserverConstructorLike,
  scheduleFrame: (callback: () => void) => number,
  cancelFrame: (frameId: number) => void,
): ResizeObserverConstructorLike {
  return class FrameResizeObserver implements ResizeObserverLike {
    #native: ResizeObserverLike
    #observed = new Set<object>()
    #pending = new Map<object, ResizeEntryLike>()
    #frameId: number | undefined

    constructor(callback: (entries: readonly ResizeEntryLike[], observer: ResizeObserverLike) => void) {
      this.#native = new NativeResizeObserver((entries) => {
        for (const entry of entries) {
          if (this.#observed.has(entry.target)) this.#pending.set(entry.target, entry)
        }
        if (this.#pending.size > 0 && this.#frameId === undefined) {
          this.#frameId = scheduleFrame(() => {
            this.#frameId = undefined
            const pending = [...this.#pending.values()]
            this.#pending.clear()
            callback(pending, this)
          })
        }
      })
    }

    observe(target: object, options?: unknown) {
      this.#observed.add(target)
      this.#native.observe(target, options)
    }

    unobserve(target: object) {
      this.#observed.delete(target)
      this.#pending.delete(target)
      if (this.#pending.size === 0 && this.#frameId !== undefined) {
        cancelFrame(this.#frameId)
        this.#frameId = undefined
      }
      this.#native.unobserve(target)
    }

    disconnect() {
      if (this.#frameId !== undefined) cancelFrame(this.#frameId)
      this.#frameId = undefined
      this.#pending.clear()
      this.#observed.clear()
      this.#native.disconnect()
    }
  }
}
