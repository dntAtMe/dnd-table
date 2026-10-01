import type { EntryRendererProps } from '../knowledge/renderers';
import { WikiPageView } from './WikiPageView';
import { openWikiPage, useWiki, useWikiPage } from './wikiStore';

/** Body of a campaign page in knowledge base popups and the Compendium view. */
export function PageEntryBody({ entry, size }: EntryRendererProps) {
  const page = useWikiPage(entry.id);
  const { isGm } = useWiki();
  if (!page) return <p className="hint">This page isn't available.</p>;
  return <WikiPageView page={page} compact={size === 'popup'} onEdit={isGm ? () => openWikiPage(page.id, { edit: true }) : undefined} />;
}
