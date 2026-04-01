import React from 'react';

const GenreSkeleton: React.FC = () => {
  return (
    <div className="flex flex-wrap gap-2">
      {[...Array(15)].map((_, index) => (
        <div
          key={index}
          className="h-7 w-20 bg-gray-700 rounded-full animate-pulse"
        />
      ))}
    </div>
  );
};

export default GenreSkeleton;
