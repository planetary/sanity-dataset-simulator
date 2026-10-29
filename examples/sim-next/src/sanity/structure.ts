import {CalendarIcon} from '@sanity/icons/Calendar'
import {CogIcon} from '@sanity/icons/Cog'
import {DocumentTextIcon} from '@sanity/icons/DocumentText'
import {FolderIcon} from '@sanity/icons/Folder'
import {MenuIcon} from '@sanity/icons/Menu'
import type {StructureResolver} from 'sanity/structure'

/** The desk: singletons first, then content grouped the way editors look for it. */
export const structure: StructureResolver = (S) =>
  S.list()
    .title('Meridian')
    .items([
      S.listItem().title('Site settings').icon(CogIcon).child(S.document().schemaType('settings').documentId('settings')),
      S.listItem().title('Navigation').icon(MenuIcon).child(S.document().schemaType('navigation').documentId('navigation')),
      S.documentTypeListItem('announcement').title('Announcement bar'),
      S.divider(),
      S.documentTypeListItem('page').title('Pages'),
      S.listItem()
        .title('Articles')
        .icon(DocumentTextIcon)
        .child(
          S.list()
            .title('Articles')
            .items([
              S.listItem().title('All articles').child(S.documentTypeList('article').title('All articles').defaultOrdering([{field: 'publishedAt', direction: 'desc'}])),
              S.listItem().title('Featured').child(S.documentList().apiVersion('2025-02-19').title('Featured').filter('_type == "article" && featured == true')),
              S.listItem()
                .title('By category')
                .icon(FolderIcon)
                .child(
                  S.documentTypeList('category')
                    .title('Categories')
                    .child((categoryId) => S.documentList().apiVersion('2025-02-19').title('Articles').filter('_type == "article" && $categoryId in categories[]._ref').params({categoryId})),
                ),
              S.listItem()
                .title('By author')
                .child(
                  S.documentTypeList('author')
                    .title('Authors')
                    .child((authorId) => S.documentList().apiVersion('2025-02-19').title('Articles').filter('_type == "article" && (author._ref == $authorId || $authorId in contributors[]._ref)').params({authorId})),
                ),
            ]),
        ),
      S.documentTypeListItem('author').title('Authors'),
      S.documentTypeListItem('category').title('Categories'),
      S.divider(),
      S.documentTypeListItem('product').title('Products'),
      S.listItem()
        .title('Events')
        .icon(CalendarIcon)
        .child(
          S.list()
            .title('Events')
            .items([
              S.listItem().title('Upcoming').child(S.documentList().apiVersion('2025-02-19').title('Upcoming').filter('_type == "event" && startsAt >= now()').defaultOrdering([{field: 'startsAt', direction: 'asc'}])),
              S.listItem().title('Past').child(S.documentList().apiVersion('2025-02-19').title('Past').filter('_type == "event" && startsAt < now()').defaultOrdering([{field: 'startsAt', direction: 'desc'}])),
              S.documentTypeListItem('venue').title('Venues'),
            ]),
        ),
    ])
