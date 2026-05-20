export const Button = ({
  children,
  className = '',
  type = 'button',
  variant = 'primary',
  ...props
}) => {
  const variantClassName = variant === 'outline' ? 'outline-button' : 'submit-button';

  return (
    <button className={`${variantClassName} ${className}`.trim()} type={type} {...props}>
      {children}
    </button>
  );
};
