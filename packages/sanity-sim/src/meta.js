/**
 * Answers for the non-data endpoints Studio calls on boot. Shapes follow what
 * Studio 6.20 reads (docs/plans/evidence/sanity-sim-phase-0/request-inventory.md).
 * There is one local user with every grant: the simulator only listens on loopback.
 */

import {ORGANIZATION_ID} from './media-library.js'

export const LOCAL_USER = Object.freeze({
  id: 'local-dev',
  name: 'Local Developer',
  email: 'local-dev@sanity-sim.invalid',
  profileImage: null,
  provider: 'sanity-sim',
  role: 'administrator',
  roles: [{name: 'administrator', title: 'Administrator', description: 'sanity-sim local user (no account).'}],
})

/** `filter: 'true'` grants every permission on every document (Studio evaluates the filter per document). */
export const DOCUMENT_GRANTS = Object.freeze([
  {filter: 'true', permissions: ['read', 'create', 'update', 'history', 'editHistory']},
])

export function roleGrants() {
  return {
    administrator: [
      {
        id: 'sanity-sim-administrator',
        name: 'administrator',
        title: 'Administrator',
        description: 'sanity-sim local user',
        isCustom: false,
        config: {},
        grants: [{name: 'sanity.project.documents', params: {}}],
      },
    ],
  }
}

export function projectDocument(sim) {
  return {
    id: sim.projectId,
    displayName: `${sim.projectId} (sanity-sim)`,
    studioHost: null,
    organizationId: ORGANIZATION_ID,
    isBlocked: false,
    isDisabled: false,
    isDisabledByUser: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    maxRetentionDays: 3650,
    activityFeedEnabled: false,
    members: [{id: LOCAL_USER.id, role: 'administrator', isRobot: false, isCurrentUser: true}],
    features: [],
    metadata: {color: '#0b6e4f', externalStudioHost: ''},
  }
}

export function datasetDocument(sim, name) {
  return {
    name,
    aclMode: 'public',
    createdAt: '2026-01-01T00:00:00Z',
    createdByUserId: LOCAL_USER.id,
    addonFor: null,
    datasetProfile: 'content',
    features: [],
    tags: [],
  }
}

/** Upsell/limit banners: report "nothing to say" (the answers Phase 0 showed Studio 6.20 accepts). */
export function journeyAnswer(kind) {
  switch (kind) {
    case 'announcements':
      return []
    case 'trial':
      return null
    case 'asset-limit':
    case 'document-limit':
      return {limit: null, usage: 0, status: 'ok'}
    case 'scheduled-drafts':
    case 'content-releases':
      return {enabled: false}
    default:
      return []
  }
}
