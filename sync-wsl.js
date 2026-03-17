// /api/sync-wsl.js
// Runs every 5 minutes via Vercel Cron
// Fetches live WSL results and writes to Supabase
// WSL Event IDs: Bells=436 (add others as season progresses)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key bypasses RLS
);

// WSL Event IDs mapped to our event IDs
// Add each event's WSL ID as the season progresses
const WSL_EVENT_MAP = {
  1:  436,  // Bells Beach
  2:  null, // Margaret River - TBD
  3:  null, // Snapper - TBD
  4:  null, // Raglan - TBD
  5:  null, // El Salvador - TBD
  6:  null, // Saquarema - TBD
  7:  null, // Teahupo'o - TBD
  8:  null, // Cloudbreak - TBD
  9:  null, // Trestles - TBD
  10: null, // Abu Dhabi - TBD
  11: null, // Peniche - TBD
  12: null, // Pipeline - TBD
};

export default async function handler(req, res) {
  // Verify this is called by Vercel Cron (not a random request)
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Find active events
    const { data: activeEvents } = await supabase
      .from('events')
      .select('id, name, wsl_event_id, stop_number')
      .eq('status', 'active');

    if (!activeEvents || activeEvents.length === 0) {
      // No active events — but check if any should be activated based on time
      await autoActivateEvents();
      return res.json({ message: 'No active events', activated: true });
    }

    const syncResults = [];

    for (const event of activeEvents) {
      const wslId = event.wsl_event_id || WSL_EVENT_MAP[event.id];
      if (!wslId) {
        syncResults.push({ event: event.name, skipped: 'No WSL ID' });
        continue;
      }

      try {
        const results = await fetchWSLResults(wslId, event);
        if (results.length > 0) {
          await writeResults(event.id, results);
          syncResults.push({ event: event.name, updated: results.length });
        } else {
          syncResults.push({ event: event.name, updated: 0, note: 'No results yet' });
        }
      } catch (err) {
        syncResults.push({ event: event.name, error: err.message });
      }
    }

    // 2. Check if any active events should be completed
    await autoCompleteEvents();

    return res.json({ 
      synced: true, 
      timestamp: new Date().toISOString(),
      results: syncResults 
    });

  } catch (err) {
    console.error('WSL sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────
// FETCH RESULTS FROM WSL
// Tries multiple WSL API endpoints
// ─────────────────────────────────────────

async function fetchWSLResults(wslEventId, event) {
  // WSL has an unofficial API used by their app
  // Try the JSON endpoint that the WSL results page uses internally
  const endpoints = [
    `https://www.worldsurfleague.com/events/2026/ct/${wslEventId}/results.json`,
    `https://www.worldsurfleague.com/api/v1/events/${wslEventId}/results`,
    `https://www.worldsurfleague.com/events/results?eventId=${wslEventId}`,
  ];

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SurfPicks/1.0)',
          'Accept': 'application/json',
          'Referer': 'https://www.worldsurfleague.com',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (response.ok) {
        const text = await response.text();
        // Try to parse as JSON
        try {
          const data = JSON.parse(text);
          const parsed = parseWSLResults(data);
          if (parsed.length > 0) return parsed;
        } catch {
          // Not JSON — try HTML parsing
          const parsed = parseWSLHTML(text);
          if (parsed.length > 0) return parsed;
        }
      }
    } catch {
      continue; // Try next endpoint
    }
  }

  return [];
}

// ─────────────────────────────────────────
// PARSE WSL JSON RESPONSE
// Handles WSL's internal API format
// ─────────────────────────────────────────

function parseWSLResults(data) {
  const results = [];

  // WSL API format varies — handle multiple shapes
  const rounds = data?.rounds || data?.data?.rounds || data?.event?.rounds || [];

  for (const round of rounds) {
    const heats = round?.heats || [];
    for (const heat of heats) {
      const athletes = heat?.athletes || heat?.surfers || [];
      for (const athlete of athletes) {
        const name = athlete?.surfer?.name || athlete?.name || '';
        const place = athlete?.place || athlete?.position || null;
        const eliminated = athlete?.eliminated || false;

        if (!name) continue;

        // Determine result
        let result = null;
        if (place === 1 && round?.name?.toLowerCase().includes('final')) {
          result = 'win';
        } else if (eliminated) {
          result = 'elim';
        } else if (place) {
          result = 'advance';
        }

        if (result) {
          results.push({ name: normalizeName(name), result });
        }
      }
    }
  }

  return results;
}

// Minimal HTML parsing fallback
function parseWSLHTML(html) {
  // Look for structured data in page
  const results = [];
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      return parseWSLResults(data);
    } catch {}
  }
  return results;
}

// ─────────────────────────────────────────
// WRITE RESULTS TO SUPABASE
// Maps surfer names to IDs and upserts results
// ─────────────────────────────────────────

async function writeResults(eventId, nameResults) {
  // Load all surfers once
  const { data: surfers } = await supabase
    .from('surfers')
    .select('id, name');

  const toUpsert = [];

  for (const { name, result } of nameResults) {
    // Fuzzy name match
    const surfer = surfers?.find(s =>
      normalizeName(s.name) === name ||
      s.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(s.name.toLowerCase().split(' ').pop())
    );

    if (surfer) {
      toUpsert.push({
        event_id: eventId,
        surfer_id: surfer.id,
        result,
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (toUpsert.length > 0) {
    await supabase
      .from('results')
      .upsert(toUpsert, { onConflict: 'event_id,surfer_id' });
  }

  return toUpsert.length;
}

// ─────────────────────────────────────────
// AUTO-ACTIVATE EVENTS
// Checks if any upcoming event's opens_at has passed
// ─────────────────────────────────────────

async function autoActivateEvents() {
  const now = new Date().toISOString();
  
  await supabase
    .from('events')
    .update({ status: 'active' })
    .eq('status', 'upcoming')
    .lte('opens_at', now);
}

// ─────────────────────────────────────────
// AUTO-COMPLETE EVENTS
// Marks events as completed after closes_at
// ─────────────────────────────────────────

async function autoCompleteEvents() {
  const now = new Date().toISOString();

  await supabase
    .from('events')
    .update({ status: 'completed' })
    .eq('status', 'active')
    .lte('closes_at', now);
}

// ─────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────

function normalizeName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ');
}
