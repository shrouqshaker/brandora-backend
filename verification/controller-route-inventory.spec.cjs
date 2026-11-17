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
test('compiled inventory contains 66 routes, 57 protected including internal AI and nine public', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 66,
    protected: 57,
    public: 9,
    mismatches: 0,
  });
});
