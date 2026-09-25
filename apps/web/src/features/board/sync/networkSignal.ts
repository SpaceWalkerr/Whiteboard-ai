import type { NetworkSignal } from "@whiteboard/shared/sync";

/** The browser's online/offline state, so the provider drops and resumes instantly. */
export function browserNetworkSignal(): NetworkSignal {
  return {
    isOnline: () => navigator.onLine,
    subscribe: (onChange) => {
      const online = () => {
        onChange(true);
      };
      const offline = () => {
        onChange(false);
      };
      window.addEventListener("online", online);
      window.addEventListener("offline", offline);
      return () => {
        window.removeEventListener("online", online);
        window.removeEventListener("offline", offline);
      };
    },
  };
}
