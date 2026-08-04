/** PRD §13.8 — Actor. */
export interface OverlayActor {
  type: 'user' | 'agent' | 'service'
  id: string
  displayName?: string
  email?: string
}
