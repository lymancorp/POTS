import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const POLAR_CLIENT_ID = Deno.env.get('POLAR_CLIENT_ID')!
const REDIRECT_URI = 'https://bpvgkgayivflrhaypjpc.supabase.co/functions/v1/polar-callback'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://lymancorp.github.io',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
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

  const { data: { user }, error } = await sb.auth.getUser()
  if (error || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders })
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: POLAR_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'accesslink.read_all',
    state: user.id,
  })

  return new Response(
    JSON.stringify({ url: `https://flow.polar.com/oauth2/authorization?${params}` }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
