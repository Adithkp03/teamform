import { useCallback, useState } from 'react';
import { api, newIdempotencyKey } from './api';
import { useAuth } from './auth';
import { useToast } from './components/Toasts';

/**
 * "Invite to your team" action shared by the board people tab and the
 * suggestions page: the outbound half of the connect journey. The server
 * owns every rule (capacity, already-teamed, duplicate); the UI maps the
 * result codes to plain messages.
 */
export function useInvitePerson(myTeamId: string | undefined, onDone?: () => void) {
  const { token } = useAuth();
  const toast = useToast();
  const [states, setStates] = useState<Record<string, 'sending' | 'sent'>>({});

  const invite = useCallback(async (userId: string) => {
    if (!myTeamId) return;
    setStates((s) => ({ ...s, [userId]: 'sending' }));
    try {
      await api(`/api/teams/${myTeamId}/invitations`, {
        method: 'POST', token, body: { user_id: userId }, idempotencyKey: newIdempotencyKey(),
      });
      setStates((s) => ({ ...s, [userId]: 'sent' }));
      toast('Invitation sent - they will see it on their board.');
      onDone?.();
    } catch (err: any) {
      const code = err?.code;
      if (code === 'invitation_already_pending') setStates((s) => ({ ...s, [userId]: 'sent' }));
      else setStates((s) => { const n = { ...s }; delete n[userId]; return n; });
      if (code === 'invitation_already_pending') return;
      if (code === 'already_requested') toast('They already asked to join your team - check your pending requests.', 'error');
      else if (code === 'already_in_team') toast('They just joined a team.', 'error');
      else if (code === 'team_full') toast('Your team is full.', 'error');
      else toast(err.message ?? 'Invite failed', 'error');
    }
  }, [myTeamId, token, toast, onDone]);

  return { invite, states };
}
