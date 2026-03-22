import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const POLAR_CLIENT_ID = Deno.env.get('POLAR_CLIENT_ID')!
const REDIRECT_URI = 'https://bpvgkgayivflrhaypjpc.supabase.co/functions/v1/polar-callback'

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

  const { data: { user }, error } = await sb.auth.getUser()
  if (error || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  // Build Polar OAuth URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: POLAR_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'accesslink.read_all',
    state: user.id, // pass user_id through state so callback knows who to link
  })

  const polarAuthURL = `https://flow.polar.com/oauth2/authorization?${params}`

  return new Response(JSON.stringify({ url: polarAuthURL }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
