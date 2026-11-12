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
test('compiled inventory contains 58 routes, 49 protected and nine public', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 58,
    protected: 49,
    public: 9,
    mismatches: 0,
  });
});
