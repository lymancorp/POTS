import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  // Verify user is authenticated
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )
  const sbAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { data: { user }, error: authErr } = await sb.auth.getUser()
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  // Get stored Polar token
  const { data: tokenRow, error: tokenErr } = await sbAdmin
    .from('polar_tokens')
    .select('*')
    .eq('user_id', user.id)
    .single()

  if (tokenErr || !tokenRow) {
    return new Response(JSON.stringify({ error: 'polar_not_connected' }), { status: 400 })
  }

  const token       = tokenRow.access_token
  const polarUserId = tokenRow.polar_user_id

  // ── Step 1: Create transaction (Polar requires this to list new exercises)
  const txRes = await fetch(`https://www.polaraccesslink.com/v3/users/${polarUserId}/exercise-transactions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  })

  // 204 = no new exercises since last transaction
  if (txRes.status === 204) {
    return new Response(JSON.stringify({ synced: 0, message: 'no new sessions' }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  if (!txRes.ok) {
    const err = await txRes.text()
    return new Response(JSON.stringify({ error: 'transaction_failed', detail: err }), { status: 500 })
  }

  const txData    = await txRes.json()
  const txId      = txData['transaction-id']
  const exercises = txData.exercises || []

  if (!exercises.length) {
    // Commit empty transaction
    await fetch(`https://www.polaraccesslink.com/v3/users/${polarUserId}/exercise-transactions/${txId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    return new Response(JSON.stringify({ synced: 0 }), { headers: { 'Content-Type': 'application/json' } })
  }

  const synced = []

  // ── Step 2: Fetch each exercise detail
  for (const exerciseUrl of exercises) {
    try {
      const exRes = await fetch(exerciseUrl, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      })
      if (!exRes.ok) continue
      const ex = await exRes.json()

      // ── Step 3: Fetch HR zones for this exercise
      const hrRes = await fetch(`${exerciseUrl}/heart-rate-zones`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      })
      const hrZones = hrRes.ok ? await hrRes.json() : null

      // ── Map Polar exercise → our session format
      const startTime  = new Date(ex['start-time'])
      const date       = startTime.toISOString().slice(0, 10)
      const durationMs = parseDuration(ex.duration)
      const z2Minutes  = hrZones ? calcZ2Minutes(hrZones) : null

      // Build session row matching our existing sessions table schema
      const session = {
        user_id:     user.id,
        polar_id:    ex.id,
        date,
        angle:       null,   // user fills in
        type:        guessSessionType(ex),
        polar_name:  ex.id?.toString() || date,
        day_state:   null,
        pre:         { etco2: null, hr: ex['heart-rate']?.average || null, rr: null },
        cp5:         { etco2: null, hr: null, rr: null },
        cp15:        { etco2: null, hr: null, rr: null },
        cp_end:      { etco2: null, hr: ex['heart-rate']?.maximum || null, rr: null },
        z2min:       z2Minutes,
        etco2_at_60s:   null,
        etco2_at_hr100: null,
        min_under_100:  null,
        morning_state:  null,
        notes:       `Auto-imported from Polar. Sport: ${ex['sport']}. Duration: ${Math.round(durationMs/60000)}min. Avg HR: ${ex['heart-rate']?.average||'?'} bpm. Max HR: ${ex['heart-rate']?.maximum||'?'} bpm.`,
        source:      'polar',
      }

      synced.push(session)
    } catch(e) {
      console.error('Exercise fetch error:', e)
    }
  }

  // ── Step 4: Commit the transaction (marks exercises as processed)
  await fetch(`https://www.polaraccesslink.com/v3/users/${polarUserId}/exercise-transactions/${txId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}` },
  })

  // ── Step 5: Return synced sessions to client for review before saving
  // We do NOT auto-save to DB — client shows a confirmation UI first
  return new Response(JSON.stringify({ synced: synced.length, sessions: synced }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

// Parse ISO 8601 duration like PT1H23M45S → milliseconds
function parseDuration(dur: string): number {
  if (!dur) return 0
  const m = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return 0
  return ((parseInt(m[1]||'0') * 3600) + (parseInt(m[2]||'0') * 60) + parseInt(m[3]||'0')) * 1000
}

// Guess session type from duration
function guessSessionType(ex: any): string {
  const ms = parseDuration(ex.duration)
  const mins = ms / 60000
  if (mins <= 20) return 'R'
  if (mins >= 35) return 'F'
  return 'F'
}

// Calculate Zone 2 minutes from Polar HR zones
// Polar zones: 1=very light, 2=light, 3=moderate(Z2), 4=hard, 5=max
function calcZ2Minutes(hrZones: any): number | null {
  try {
    const zones = hrZones['heart-rate-zones'] || hrZones.zones || []
    // Zone index 2 (0-based) or zone name = 'LIGHT' typically maps to Z2
    const z2 = zones.find((z: any) =>
      z.index === 2 || z.name === 'AEROBIC' || z.name === 'LIGHT'
    )
    if (!z2) return null
    const inZone = z2['in-zone']
    if (!inZone) return null
    const ms = parseDuration(inZone)
    return Math.round(ms / 60000)
  } catch {
    return null
  }
}
