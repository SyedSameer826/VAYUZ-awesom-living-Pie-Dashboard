import { useState } from 'react';

export const Input = ({
  errorContent,
  icon,
  label,
  name,
  onChange,
  placeholder,
  type = 'text',
  value,
  ...props
}) => {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const inputType = type === 'password' && passwordVisible ? 'text' : type;

  return (
    <label className="form-field">
      <span>{label}</span>
      {type === 'password' ? (
        <div className="password-input">
          <input
            {...props}
            name={name}
            type={inputType}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            aria-invalid={Boolean(errorContent)}
          />
          <button
            type="button"
            onClick={() => setPasswordVisible((visible) => !visible)}
            aria-label={passwordVisible ? 'Hide password' : 'Show password'}
          >
            {passwordVisible ? 'Hide' : 'Show'}
          </button>
        </div>
      ) : icon ? (
        <div className="icon-input">
          <span className="input-icon">{icon}</span>
          <input
            {...props}
            name={name}
            type={type}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            aria-invalid={Boolean(errorContent)}
          />
        </div>
      ) : (
        <input
          {...props}
          name={name}
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          aria-invalid={Boolean(errorContent)}
        />
      )}
      {errorContent && <small>{errorContent}</small>}
    </label>
  );
};
