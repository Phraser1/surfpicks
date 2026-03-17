import { supabaseAdmin, json, err, cors, isAdmin } from './_supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { cors(res); return res.status(200).end(); }
  if (!isAdmin(req)) return err(res, 'Unauthorized', 401);

  const { action } = req.body || req.query;

  // ── SET EVENT STATUS ─────────────────────────────
  // POST { action: 'set_status', event_id: 3, status: 'active' }
  if (action === 'set_status') {
    const { event_id, status } = req.body;
    if (!['upcoming','active','completed'].includes(status)) {
      return err(res, 'Invalid status');
    }

    const { data, error } = await supabaseAdmin
      .from('events')
      .update({ status })
      .eq('id', event_id)
      .select()
      .single();

    if (error) return err(res, error.message, 500);
    return json(res, { success: true, event: data });
  }

  // ── SET RESULT FOR ONE SURFER ────────────────────
  // POST { action: 'set_result', event_id: 1, surfer_id: 3, result: 'win' }
  if (action === 'set_result') {
    const { event_id, surfer_id, result } = req.body;
    if (!['win','advance','elim'].includes(result)) {
      return err(res, 'Invalid result — must be win, advance, or elim');
    }

    const { data, error } = await supabaseAdmin
      .from('results')
      .upsert(
        { event_id, surfer_id, result, synced_at: new Date().toISOString() },
        { onConflict: 'event_id,surfer_id' }
      )
      .select()
      .single();

    if (error) return err(res, error.message, 500);
    return json(res, { success: true, result: data });
  }

  // ── BULK SET RESULTS ─────────────────────────────
  // POST { action: 'bulk_results', event_id: 1, results: [{surfer_id:1,result:'win'}, ...] }
  if (action === 'bulk_results') {
    const { event_id, results } = req.body;
    if (!Array.isArray(results)) return err(res, 'results must be an array');

    const rows = results.map(r => ({
      event_id,
      surfer_id: r.surfer_id,
      result: r.result,
      synced_at: new Date().toISOString(),
    }));

    const { data, error } = await supabaseAdmin
      .from('results')
      .upsert(rows, { onConflict: 'event_id,surfer_id' })
      .select();

    if (error) return err(res, error.message, 500);
    return json(res, { success: true, count: data.length });
  }

  // ── GET ALL PICKS (admin view) ───────────────────
  if (action === 'all_picks') {
    const { data, error } = await supabaseAdmin
      .from('picks')
      .select(`event_id, surfer_id, created_at, profiles(name, email), surfers(name, ct_rank)`)
      .order('event_id');

    if (error) return err(res, error.message, 500);
    return json(res, data);
  }

  // ── GET ALL REGISTRATIONS ────────────────────────
  if (action === 'registrations') {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return err(res, error.message, 500);
    return json(res, data);
  }

  // ── MARK PLAYER PAID ─────────────────────────────
  if (action === 'mark_paid') {
    const { user_id, paid } = req.body;
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ paid })
      .eq('id', user_id)
      .select()
      .single();

    if (error) return err(res, error.message, 500);
    return json(res, { success: true, profile: data });
  }

  return err(res, 'Unknown action');
}
