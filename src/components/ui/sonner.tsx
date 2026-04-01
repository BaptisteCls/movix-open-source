import { Toaster as Sonner } from 'sonner';

const Toaster = ({ ...props }) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-gray-900 group-[.toaster]:text-white group-[.toaster]:border-white/10 group-[.toaster]:shadow-lg group-[.toaster]:rounded-xl',
          description: 'group-[.toast]:text-white/60',
          actionButton:
            'group-[.toast]:bg-red-600 group-[.toast]:text-white',
          cancelButton:
            'group-[.toast]:bg-white/10 group-[.toast]:text-white',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
