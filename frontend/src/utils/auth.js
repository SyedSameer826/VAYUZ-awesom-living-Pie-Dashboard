export const logout = () => {
  localStorage.removeItem("token"); // remove auth token
  localStorage.removeItem("user"); // optional

  window.location.href = "/signin"; // force redirect
};
