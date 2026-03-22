import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const POLAR_CLIENT_ID     = Deno.env.get('POLAR_CLIENT_ID')!
const POLAR_CLIENT_SECRET = Deno.env.get('POLAR_CLIENT_SECRET')!
const REDIRECT_URI        = 'https://bpvgkgayivflrhaypjpc.supabase.co/functions/v1/polar-callback'
const APP_URL             = 'https://lymancorp.github.io/POTS/'

serve(async (req) => {
  const url    = new URL(req.url)
  const code   = url.searchParams.get('code')
  const userId = url.searchParams.get('state') // user_id passed through state

  if (!code || !userId) {
    return new Response('Missing code or state', { status: 400 })
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://polarremote.com/v2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`),
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    console.error('Token exchange failed:', err)
    return Response.redirect(`${APP_URL}?polar_error=token_failed`, 302)
  }

  const tokenData = await tokenRes.json()
  const accessToken   = tokenData.access_token
  const polarUserId   = tokenData.x_user_id

  // Register user with Polar Accesslink (required once per user)
  const regRes = await fetch('https://www.polaraccesslink.com/v3/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
    body: JSON.stringify({ 'member-id': userId }),
  })

  // 409 = already registered, that's fine
  if (!regRes.ok && regRes.status !== 409) {
    const err = await regRes.text()
    console.error('Polar user registration failed:', err)
    return Response.redirect(`${APP_URL}?polar_error=reg_failed`, 302)
  }

  // Store token in Supabase using service role key (bypasses RLS)
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { error } = await sb.from('polar_tokens').upsert({
    user_id:       userId,
    polar_user_id: polarUserId,
    access_token:  accessToken,
  }, { onConflict: 'user_id' })

  if (error) {
    console.error('Token save failed:', error)
    return Response.redirect(`${APP_URL}?polar_error=save_failed`, 302)
  }

  // Redirect back to app with success flag
  return Response.redirect(`${APP_URL}?polar_connected=1`, 302)
})
