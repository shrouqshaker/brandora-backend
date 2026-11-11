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
test('compiled inventory contains 57 routes, 48 protected and nine public', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 57,
    protected: 48,
    public: 9,
    mismatches: 0,
  });
});