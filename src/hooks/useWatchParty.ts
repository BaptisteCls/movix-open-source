import { useState } from 'react';
// TODO: Utiliser socket.io-client ou équivalent
// import io from 'socket.io-client';

interface UseWatchPartyOptions {
  src: string;
  title?: string;
  videoRef: React.RefObject<HTMLVideoElement>;
  onSync: (action: any) => void;
}

export default function useWatchParty({ src, title, videoRef, onSync }: UseWatchPartyOptions) {
  const [isInParty, setIsInParty] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [partyId, setPartyId] = useState<string | null>(null);
  const [partyState, setPartyState] = useState<any>(null);
  // const socket = useRef<any>(null);

  // TODO: Connexion WebSocket, gestion JWT, synchronisation vidéo, etc.

  const startParty = (pseudo: string) => {
    // TODO: Appel REST pour créer la party, récupérer JWT, ouvrir WebSocket
    setIsInParty(true);
    setIsHost(true);
    setPartyId('demo123');
    // ...
  };

  const joinParty = (partyId: string, pseudo: string) => {
    // TODO: Appel REST pour rejoindre la party, récupérer JWT, ouvrir WebSocket
    setIsInParty(true);
    setIsHost(false);
    setPartyId(partyId);
    // ...
  };

  const leaveParty = () => {
    // TODO: Déconnexion WebSocket
    setIsInParty(false);
    setIsHost(false);
    setPartyId(null);
  };

  return {
    isInParty,
    isHost,
    partyId,
    partyState,
    startParty,
    joinParty,
    leaveParty,
  };
}
