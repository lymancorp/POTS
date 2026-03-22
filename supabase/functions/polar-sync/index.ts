import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://lymancorp.github.io',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function parseDuration(dur: string): number {
  if (!dur) return 0
  const m = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return 0
  return ((parseInt(m[1]||'0')*3600)+(parseInt(m[2]||'0')*60)+parseInt(m[3]||'0'))*1000
}
function guessType(ex: any): string {
  const mins = parseDuration(ex.duration)/60000
  return mins <= 20 ? 'R' : 'F'
}
function calcZ2(hrZones: any): number|null {
  try {
    const zones = hrZones['heart-rate-zones']||hrZones.zones||[]
    const z2 = zones.find((z:any)=>z.index===2||z.name==='AEROBIC'||z.name==='LIGHT')
    if (!z2?.['in-zone']) return null
    return Math.round(parseDuration(z2['in-zone'])/60000)
  } catch { return null }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders })
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
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders })
  }

  const { data: tokenRow } = await sbAdmin.from('polar_tokens').select('*').eq('user_id', user.id).single()
  if (!tokenRow) {
    return new Response(JSON.stringify({ error: 'polar_not_connected' }), { status: 400, headers: corsHeaders })
  }

  const token = tokenRow.access_token
  const polarUserId = tokenRow.polar_user_id

  const txRes = await fetch(`https://www.polaraccesslink.com/v3/users/${polarUserId}/exercise-transactions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  })

  if (txRes.status === 204) {
    return new Response(JSON.stringify({ synced: 0, message: 'no new sessions' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  if (!txRes.ok) {
    return new Response(JSON.stringify({ error: 'transaction_failed' }), { status: 500, headers: corsHeaders })
  }

  const txData = await txRes.json()
  const txId = txData['transaction-id']
  const exercises = txData.exercises || []

  const synced = []
  for (const exerciseUrl of exercises) {
    try {
      const exRes = await fetch(exerciseUrl, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } })
      if (!exRes.ok) continue
      const ex = await exRes.json()
      const hrRes = await fetch(`${exerciseUrl}/heart-rate-zones`, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } })
      const hrZones = hrRes.ok ? await hrRes.json() : null
      const date = new Date(ex['start-time']).toISOString().slice(0,10)
      synced.push({
        id: Date.now() + Math.random(),
        date, angle: null, type: guessType(ex),
        polarName: ex.id?.toString()||date,
        dayState: null,
        pre: { etco2: null, hr: ex['heart-rate']?.average||null, rr: null },
        cp5: { etco2: null, hr: null, rr: null },
        cp15: { etco2: null, hr: null, rr: null },
        cpEnd: { etco2: null, hr: ex['heart-rate']?.maximum||null, rr: null },
        z2min: hrZones ? calcZ2(hrZones) : null,
        etco2at60s: null, etco2atHR100: null, minUnder100: null,
        morningState: null, morningSupineHR: null, morningStandingHR: null,
        notes: `Polar import · ${ex['sport']} · ${Math.round(parseDuration(ex.duration)/60000)}min · avg HR ${ex['heart-rate']?.average||'?'} · max HR ${ex['heart-rate']?.maximum||'?'}`,
        source: 'polar',
      })
    } catch(e) { console.error('exercise error:', e) }
  }

  await fetch(`https://www.polaraccesslink.com/v3/users/${polarUserId}/exercise-transactions/${txId}`, {
    method: 'PUT', headers: { 'Authorization': `Bearer ${token}` },
  })

  return new Response(
    JSON.stringify({ synced: synced.length, sessions: synced }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
