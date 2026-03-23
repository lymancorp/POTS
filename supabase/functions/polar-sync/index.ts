import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://lymancorp.github.io',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({error:'unauthorized'}), {status:401,headers:corsHeaders})
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {global:{headers:{Authorization:authHeader}}})
  const sbAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data:{user}, error:authErr } = await sb.auth.getUser()
  if (authErr||!user) return new Response(JSON.stringify({error:'unauthorized'}), {status:401,headers:corsHeaders})
  const {data:tokenRow} = await sbAdmin.from('polar_tokens').select('*').eq('user_id',user.id).single()
  if (!tokenRow) return new Response(JSON.stringify({error:'polar_not_connected'}), {status:400,headers:corsHeaders})
  const token = tokenRow.access_token
  const polarUserId = tokenRow.polar_user_id
  const debug: any = { polar_user_id: polarUserId, token_preview: token?.slice(0,20)+'...' }
  const userRes = await fetch(`https://www.polaraccesslink.com/v3/users/${polarUserId}`, {
    headers: {'Authorization': `Bearer ${token}`, 'Accept': 'application/json'}
  })
  debug.user_status = userRes.status
  if (userRes.ok) { const u = await userRes.json(); debug.member_id = u['member-id']; debug.reg_date = u['registration-date'] }
  else { debug.user_error = await userRes.text() }
  const txRes = await fetch(`https://www.polaraccesslink.com/v3/users/${polarUserId}/exercise-transactions`, {
    method:'POST', headers:{'Authorization':`Bearer ${token}`,'Accept':'application/json'}
  })
  debug.tx_status = txRes.status
  if (txRes.status===204) return new Response(JSON.stringify({synced:0,message:'no new sessions',debug}), {headers:{...corsHeaders,'Content-Type':'application/json'}})
  if (!txRes.ok) { debug.tx_error = await txRes.text(); return new Response(JSON.stringify({error:'transaction_failed',debug}), {status:500,headers:corsHeaders}) }
  const txData = await txRes.json()
  debug.tx_data = txData
  await fetch(`https://www.polaraccesslink.com/v3/users/${polarUserId}/exercise-transactions/${txData['transaction-id']}`, {
    method:'PUT', headers:{'Authorization':`Bearer ${token}`}
  })
  return new Response(JSON.stringify({synced:0,debug}), {headers:{...corsHeaders,'Content-Type':'application/json'}})
})
