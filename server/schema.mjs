// Pestis database layout (SQLite). The server makes any table or column that's missing when it starts,
// so a newer version of this file updates the database by itself.
//
// Column types:  text | int | real | bool | json | ts (date and time) | date | uuid
// Defaults:      'now' (the time it's saved), 'uid' (the signed-in person's id), 'uuid' (a new random id),
//                'identity' (the next number: 1, 2, 3 ...), or a fixed value.

const c = (type, extra = {}) => Object.assign({ type }, extra);
const NOW = { def: 'now', nn: true };

export const TABLES = {
  // ---------- people ----------
  profiles: {                         // staff: made automatically the first time someone signs in
    pk: ['id'],
    cols: {
      id: c('uuid', { nn: true }), email: c('text'), full_name: c('text'), avatar_url: c('text'),
      approved: c('bool', { def: false, nn: true }), role: c('text', { def: 'technician', nn: true }),
      created_at: c('ts', NOW),
      job_title: c('text'), bio: c('text'), phone: c('text'), contact_email: c('text'), photo_path: c('text'),
      portal_visible: c('bool', { def: true, nn: true }), ui_prefs: c('json', { def: {}, nn: true }),
    },
  },
  allowed_emails: {                   // staff an admin approved before they first signed in
    pk: ['email'],
    cols: { email: c('text', { nn: true }), role: c('text', { def: 'technician', nn: true }), added_at: c('ts', NOW), added_by: c('text') },
  },
  client_users: {                     // Client Portal logins
    pk: ['email'],
    cols: {
      email: c('text', { nn: true }), full_name: c('text'), company: c('text'), phone: c('text'),
      active: c('bool', { def: true, nn: true }), notes: c('text'), added_by: c('text'), created_at: c('ts', NOW), last_seen_at: c('ts'),
    },
  },
  client_access: {                    // the sites each client login can see
    pk: ['email', 'client_id'],
    cols: { email: c('text', { nn: true }), client_id: c('text', { nn: true }), added_by: c('text'), added_at: c('ts', NOW) },
  },
  user_prefs: {                       // each person's own settings
    pk: ['user_id'],
    cols: { user_id: c('uuid', { def: 'uid', nn: true }), prefs: c('json', { def: {}, nn: true }), updated_at: c('ts', NOW) },
  },
  staff_days: {                       // Start day / End day
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), user_id: c('uuid', { def: 'uid', nn: true }), technician: c('text'),
      started_at: c('ts', { nn: true }), ended_at: c('ts'), sites: c('json', { def: [], nn: true }), summary: c('json', { def: {}, nn: true }),
      created_at: c('ts', NOW), updated_at: c('ts', NOW),
    },
    index: [['user_id', 'started_at']],
  },

  // ---------- sites ----------
  clients: {
    pk: ['id'], identity: 'id',
    cols: {
      id: c('int', { def: 'identity', nn: true }), Name: c('text', { nn: true }), Address: c('text'), Contact: c('text'), Email: c('text'), Notes: c('text'),
      created_at: c('ts', NOW), visit_type: c('text'), image_path: c('text'), services: c('json', { def: [], nn: true }),
      contract_start: c('date'), contract_end: c('date'), contract_notes: c('text'), assigned_to: c('uuid'),
      visit_started_at: c('ts'), visit_started_by: c('uuid'),
      visit_hold_from: c('ts'),   // set by the server when a visit starts: clients see records from then on once it's finished
    },
  },
  service_logs: {                     // one row per station check
    pk: ['id'], identity: 'id',
    cols: {
      id: c('int', { def: 'identity', nn: true }), client_id: c('int', { nn: true }), barcode_id: c('text', { nn: true }),
      payload: c('json', { def: {}, nn: true }), created_at: c('ts', NOW), technician_id: c('uuid', { def: 'uid' }),
    },
    index: [['client_id', 'created_at'], ['client_id', 'barcode_id']],
  },
  recommendations: {
    pk: ['id'], identity: 'rec_no',
    cols: {
      id: c('text', { nn: true }), rec_no: c('int', { def: 'identity', nn: true }), client_id: c('text', { nn: true }),
      station_barcode: c('text'), station_name: c('text'), station_type: c('text'), text: c('text', { def: '', nn: true }),
      photos: c('json', { def: [], nn: true }), status: c('text', { def: 'open', nn: true, oneOf: ['open', 'pending', 'complete'] }),
      raised_at: c('ts', NOW), raised_by: c('text'), raised_by_id: c('uuid', { def: 'uid' }), completed_at: c('ts'),
      created_at: c('ts', NOW), updated_at: c('ts', NOW), category: c('text'), details: c('text'),
    },
    unique: [['rec_no']], index: [['client_id'], ['status']],
  },
  recommendation_updates: {
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), rec_id: c('text', { nn: true }), client_id: c('text', { nn: true }), status: c('text'), note: c('text'),
      photos: c('json', { def: [], nn: true }), technician: c('text'), at: c('ts', NOW), created_at: c('ts', NOW),
      by_client: c('bool', { def: false, nn: true }),
    },
    index: [['client_id'], ['rec_id'], ['by_client', 'at']],
  },
  recommendation_views: {
    pk: ['rec_id', 'viewer_key'],
    cols: {
      rec_id: c('text', { nn: true }), client_id: c('text', { nn: true }), viewer_key: c('text', { nn: true }), viewer_name: c('text'),
      is_client: c('bool', { def: false, nn: true }), first_seen_at: c('ts', NOW), last_seen_at: c('ts', NOW), view_count: c('int', { def: 1, nn: true }),
    },
    index: [['client_id']],
  },
  recommendation_view_log: {          // every time someone opens a recommendation (who, when, in which app)
    pk: ['id'],
    cols: {
      id: c('text', { def: 'uuid', nn: true }), rec_id: c('text', { nn: true }), client_id: c('text', { nn: true }), viewer_key: c('text', { nn: true }),
      viewer_name: c('text'), is_client: c('bool', { def: false, nn: true }), app: c('text'), at: c('ts', NOW),
    },
    index: [['rec_id', 'at'], ['client_id']],
  },
  site_maps: {
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), client_id: c('text', { nn: true }), name: c('text', { def: 'Floor plan', nn: true }), image_path: c('text'),
      width: c('int'), height: c('int'), sort: c('real', { def: 0, nn: true }), created_by: c('text'), created_at: c('ts', NOW), updated_at: c('ts', NOW),
      drawing: c('json'), building_id: c('text'),
    },
    index: [['client_id']],
  },
  // a site's buildings: each floor plan sits under one (site_maps.building_id); a station is on a floor plan (stations.map_id)
  site_buildings: {
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), client_id: c('text', { nn: true }), name: c('text', { def: 'Building', nn: true }), sort: c('real', { def: 0, nn: true }),
      created_by: c('text'), created_at: c('ts', NOW), updated_at: c('ts', NOW),
    },
    index: [['client_id']],
  },
  stations: {
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), client_id: c('text', { nn: true }), barcode: c('text', { nn: true }), name: c('text', { def: '', nn: true }), type: c('text'),
      map_id: c('text'), pin_x: c('real'), pin_y: c('real'), created_by: c('text'), created_at: c('ts', NOW), updated_at: c('ts', NOW),
      photo_path: c('text'), limit_id: c('text'),
    },
    unique: [['client_id', 'barcode']], index: [['client_id']],
  },
  visits: {
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), client_id: c('text', { nn: true }), visit_type: c('text'), technician: c('text'), technician_id: c('uuid', { def: 'uid' }),
      started_at: c('ts'), completed_at: c('ts', NOW), signed_in_at: c('ts'), signed_out_at: c('ts'), notes: c('text'),
      services_completed: c('json', { def: [], nn: true }), unscanned_count: c('int'), edited_at: c('ts'), edited_by: c('text'), created_at: c('ts', NOW),
      signed_by: c('text'), signature_path: c('text'), signed_at: c('ts'), no_signature_reason: c('text'),
    },
    index: [['client_id']],
  },
  site_events: {
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), client_id: c('text', { nn: true }), action: c('text'), title: c('text'), detail: c('text'), station: c('text'),
      technician: c('text'), at: c('ts', NOW), created_at: c('ts', NOW),
    },
    index: [['client_id'], ['action', 'at']],
  },
  site_documents: {
    pk: ['id'],
    cols: {
      id: c('text', { def: 'uuid', nn: true }), client_id: c('text', { nn: true }), category: c('text', { def: 'Other', nn: true }), title: c('text', { nn: true }),
      file_path: c('text', { nn: true }), file_name: c('text'), mime_type: c('text'), size_bytes: c('int'), expires_on: c('date'), notes: c('text'),
      uploaded_by: c('text'), uploaded_by_id: c('uuid', { def: 'uid' }), created_at: c('ts', NOW), updated_at: c('ts', NOW), folder: c('text'),
    },
    index: [['client_id']],
  },
  site_document_folders: {
    pk: ['id'],
    cols: { id: c('text', { def: 'uuid', nn: true }), client_id: c('text', { nn: true }), name: c('text', { nn: true }), created_by: c('text'), created_at: c('ts', NOW) },
    unique: [['client_id', 'name']],
  },
  pest_sightings: {
    pk: ['id'],
    cols: {
      id: c('text', { def: 'uuid', nn: true }), client_id: c('text', { nn: true }), sighting_no: c('int'), pest: c('text', { nn: true }),
      location: c('text', { nn: true }), station_barcode: c('text'), seen_at: c('ts', NOW), number_seen: c('int'), evidence: c('text'),
      urgency: c('text', { def: 'Routine', nn: true, oneOf: ['Routine', 'Urgent'] }), reported_by: c('text', { nn: true }), reporter_contact: c('text'),
      details: c('text'), photos: c('json', { def: [], nn: true }), status: c('text', { def: 'new', nn: true, oneOf: ['new', 'actioned', 'reviewed'] }),
      action_notes: c('text'), actioned_by: c('text'), actioned_at: c('ts'), action_photos: c('json', { def: [], nn: true }),
      client_reviewed_by: c('text'), client_reviewed_at: c('ts'), client_review_note: c('text'), created_by: c('text'),
      created_at: c('ts', NOW), updated_at: c('ts', NOW),
    },
    index: [['client_id', 'seen_at'], ['status']],
  },
  site_limits: {                      // critical limits
    pk: ['id'],
    cols: {
      id: c('text', { def: 'uuid', nn: true }), client_id: c('text', { nn: true }), name: c('text', { nn: true }), rules: c('json', { def: [], nn: true }),
      notes: c('text'), created_by: c('text'), created_at: c('ts', NOW), updated_by: c('text'), updated_at: c('ts', NOW),
    },
    index: [['client_id']],
  },
  site_contacts: {
    pk: ['id'],
    cols: {
      id: c('text', { def: 'uuid', nn: true }), client_id: c('text', { nn: true }), name: c('text', { nn: true }), role: c('text'), phone: c('text'),
      email: c('text'), notes: c('text'), is_primary: c('bool', { def: false, nn: true }), sort: c('int', { def: 0, nn: true }),
      created_by: c('text'), created_at: c('ts', NOW), updated_by: c('text'), updated_at: c('ts', NOW),
    },
    index: [['client_id']],
  },

  // ---------- team lists and settings ----------
  preparations: {
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), label: c('text', { nn: true }), unit: c('text', { def: 'each', nn: true }), sort: c('int', { def: 0, nn: true }),
      created_at: c('ts', NOW), sds_path: c('text'), sds_name: c('text'), sds_expires: c('date'), sds_updated_at: c('ts'), sds_updated_by: c('text'),
    },
  },
  species: {
    pk: ['id'],
    cols: {
      id: c('text', { nn: true }), label: c('text', { nn: true }), sort: c('int', { def: 0, nn: true }), created_at: c('ts', NOW),
      category: c('text'), photo_path: c('text'), photo_source: c('text'), subcategory: c('text'), gallery: c('json'),
      about: c('text'), breeding: c('text'), control: c('text'), updated_at: c('ts'), updated_by: c('text'),
    },
  },
  station_types: {
    pk: ['id'],
    cols: { id: c('text', { nn: true }), label: c('text', { nn: true }), sort: c('int', { def: 0, nn: true }), created_at: c('ts', NOW), color: c('text') },
  },
  app_settings: {
    pk: ['key'],
    cols: { key: c('text', { nn: true }), value: c('json'), updated_by: c('text'), updated_at: c('ts', NOW) },
  },
};

// The preparations the business uses, with the unit each is measured in (the owner's list)
export const PREPARATIONS = [
  ['Light Bulb', 'each'], ['Maki Block', 'each'], ['Contrac', 'each'], ['Generation', 'each'], ['Key Aqua Delta', 'ml'], ['Zetapy', 'ml'],
  ['Forgot', 'L'], ['VK2', 'L'], ['Anteater Ant Gel', 'g'], ['Advion Cockroach Gel', 'g'], ['Glue Board', 'each'],
  ['MAC Slay Residual Insecticide', 'ml'], ['Dust to Dust', 'g'], ['WaspJet Pro', 'each'], ['STORGARD', 'each'],
];
// Starting lists for a brand-new database (only added while a list is empty)
export const SEED = {
  preparations: PREPARATIONS.map(([label, unit], i) => ({ id: 'seed-prep-' + (i + 1), label, sort: i + 1, unit })),
  species: [
    'Rat', 'Mice', 'German Cockroach', 'American Cockroach', 'Fly', 'Ants',
  ].map((label, i) => ({ id: 'seed-species-' + (i + 1), label, sort: i + 1 })),
  station_types: [
    'External Non-Toxic Rodent Station', 'Internal Non-Toxic Rodent Station', 'Flying Insect Monitoring', 'Crawling Insect Monitoring',
    'External Toxic Rodent Station', 'Internal Toxic Rodent Station', 'Pest Sighting Register', 'Inspection Point',
  ].map((label, i) => ({ id: 'seed-station-' + (i + 1), label, sort: i + 1 })),
};

// Every site gets these document folders
export const STANDARD_FOLDERS = ['SDS', 'Service agreement', 'Maps', 'Site specific', 'Meeting notes', 'Entomology', 'Training', 'Insurance'];

// Who can see what. "Site" tables hold one site's data: staff see every site, a client login sees only its own sites.
export const SITE_TABLES = new Set(['service_logs', 'recommendations', 'recommendation_updates', 'stations', 'site_maps', 'visits', 'site_documents',
  'site_document_folders', 'recommendation_views', 'recommendation_view_log', 'pest_sightings', 'site_limits', 'site_buildings']);
export const LIST_TABLES = new Set(['preparations', 'species', 'station_types']);
// Tables the apps get live updates for
export const LIVE_TABLES = new Set(['service_logs', 'recommendations', 'recommendation_updates', 'stations', 'site_maps', 'visits', 'site_events',
  'pest_sightings', 'site_documents', 'site_document_folders', 'recommendation_views', 'clients', 'site_limits', 'site_contacts', 'site_buildings']);

export const BUCKETS = { 'station-photos': { maxBytes: 52428800 }, 'site-documents': { maxBytes: 52428800 } };
