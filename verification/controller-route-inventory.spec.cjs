const {
  controllerRoutes,
  verifyRoutePolicy,
  verifyControllerInventory,
} = require('./controller-route-inventory.cjs');

const routes = controllerRoutes();
test.each(routes)(
  '$verb $route has the reviewed compiled authorization policy',
  (route) => {
    verifyRoutePolicy(route);
  },
);
test('compiled inventory contains 48 distinct routes, 42 protected and six rate-limited public Auth routes', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 48,
    protected: 42,
    public: 6,
    mismatches: 0,
  });
});
