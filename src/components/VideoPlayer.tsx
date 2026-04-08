import React, { useEffect } from 'react';

interface VideoPlayerProps {
  movieId: string;
  nextMovie?: any;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ movieId, nextMovie }) => {
  useEffect(() => {
    const iframe = document.querySelector('iframe');
    if (iframe) {
      const iframeWindow = iframe.contentWindow;
      if (iframeWindow) {
        iframeWindow.document.head.innerHTML += `
          <script src="https://cdn.jsdelivr.net/npm/disable-devtool"></script>
          <script>
            DisableDevtool({
              ondevtoolopen: function() {
                window.location.reload();
              }
            });
          </script>
        `;
      }
    }
  }, []);

  return (
    <iframe
      src={`https://frembed.help/api/film.php?id=${movieId}`}
      width="100%"
      height="500px"
      frameBorder="0"
      allowFullScreen
      scrolling="no"
      style={{ overflow: 'hidden' }}
      sandbox="allow-scripts allow-same-origin"
    />
  );
};

export default VideoPlayer; 