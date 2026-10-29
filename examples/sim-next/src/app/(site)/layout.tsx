import {draftMode} from 'next/headers'
import {VisualEditing} from 'next-sanity/visual-editing'
import {SanityLive} from '../../sanity/live'

export default async function SiteLayout({children}: {children: React.ReactNode}) {
  const {isEnabled: isDraftMode} = await draftMode()
  return (
    <>
      {isDraftMode && (
        <p id="draft-mode">
          Draft mode · <a href="/api/draft-mode/disable">exit</a>
        </p>
      )}
      {children}
      <SanityLive />
      {isDraftMode && <VisualEditing />}
    </>
  )
}
