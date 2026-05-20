import { useState } from "react";
import { Button } from "../../../components/buttons";
import { Input } from "../../../components/inputs";
import { BASE_URL } from "../../../constants/auth";
export const SignIn = ({ onLogin }) => {
  const [form, setForm] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState("");

  const handleChange = (event) => {
    const { name, value } = event.target;

    setForm((current) => ({
      ...current,
      [name]: value.replace(/\s/g, ""),
    }));

    setErrors((current) => ({
      ...current,
      [name]: "",
    }));

    setApiError("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const nextErrors = {};

    if (!form.email) {
      nextErrors.email = "Email Address is required";
    } else if (!/^\S+@\S+\.\S+$/.test(form.email)) {
      nextErrors.email = "Enter a valid email address";
    }

    if (!form.password) {
      nextErrors.password = "Password is required";
    }

    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) return;

    try {
      setLoading(true);
      setApiError("");

      const response = await fetch(`${BASE_URL}/user/auth/sign-in`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: form.email,
          password: form.password,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        // optional: save token if API returns one
        // localStorage.setItem('token', data.token);

        onLogin(form.email, data);
      } else if (response.status === 400) {
        setApiError(data.message || "Validation error");
      } else if (response.status === 401) {
        setApiError("Invalid email or password");
      } else {
        setApiError("Something went wrong");
      }
    } catch (error) {
      setApiError("Network error. Please try again.");
      console.error("Sign in error:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="auth-shell otp-auth-shell">
      <div className="auth-logo-wrap">
        <img
          className="auth-logo al-logo"
          src="/icons/ALlogo.png"
          alt="Awesome Living"
        />
      </div>

      <div className="auth-wave" aria-hidden="true"></div>

      <form
        className="login-form otp-login-card"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="login-heading">
          <h2>Welcome Back</h2>
          <p>signin</p>
        </div>

        <div>
          <Input
            name="email"
            type="email"
            autoComplete="email"
            label="Email Address"
            value={form.email}
            onChange={handleChange}
            placeholder="admin@example.com"
            errorContent={errors.email}
            icon={
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6.75A2.75 2.75 0 0 1 6.75 4h10.5A2.75 2.75 0 0 1 20 6.75v10.5A2.75 2.75 0 0 1 17.25 20H6.75A2.75 2.75 0 0 1 4 17.25V6.75Zm2.75-1.25c-.31 0-.6.1-.82.28l5.07 4.45c.57.5 1.43.5 2 0l5.07-4.45a1.25 1.25 0 0 0-.82-.28H6.75Zm11.75 2.1-4.5 3.95a3 3 0 0 1-4 0L5.5 7.6v9.65c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V7.6Z" />
              </svg>
            }
          />
        </div>

        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          label="Password"
          value={form.password}
          onChange={handleChange}
          placeholder="Enter your password"
          errorContent={errors.password}
        />

        {apiError && (
          <p
            className="error-text"
            style={{ color: "red", marginBottom: "12px" }}
          >
            {apiError}
          </p>
        )}

        <Button type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </section>
  );
};

export default SignIn;
